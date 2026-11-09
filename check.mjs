#!/usr/bin/env node
/**
 * everydeck/check: the guard on every push. Runs on GitHub in the app's repository; everydeck never sees the code, only the result.
 *
 *   1. Provide the tools: the skeleton @everydeck/check from npm and the check everydeck-check from PyPI, each in a fixed version (TOOLS); no vendor/.
 *   2. Re-anchor places that moved (git, text, symbol: everydeck-check reanchor), then run the skeleton with --merge (new tables, pages, routes).
 *   3. Is every everydeck call still there? (everydeck-check drift against everydeck-manifest.lock.json) If one is missing, the check is red: one sentence per finding
 *      and the prompt for the coding agent in the check text.
 *   4. Send the result to everydeck (signed in with the run's OIDC token, no key); green after a push to the default branch: with the new app map.
 *
 * Inputs (action.yml): EVERYDECK_URL, EVERYDECK_PROJECT. From GitHub: GITHUB_WORKSPACE, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_EVENT_PATH,
 * GITHUB_STEP_SUMMARY, RUNNER_TEMP, ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN (only with `permissions: id-token: write`).
 * For local runs: EVERYDECK_CHECK_PYTHON (Python with everydeck-check installed), EVERYDECK_TYPESCRIPT_DIR (node_modules with typescript); npm and pip
 * follow their own settings (npm_config_registry, PIP_INDEX_URL, PIP_FIND_LINKS).
 * If everydeck is unreachable the build does not break (warning); the check turns red only when an everydeck call is missing.
 * Each run costs the app's owner GitHub Actions minutes (GitHub bills every job rounded up to a whole minute): the workflow runs only when a file it lists under
 * `paths` changes; this script says when a file with an everydeck call is not in that list, and how long each part of the run took.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { covers, globOf, watchedFiles, workflowFile } from './paths.mjs';

const env = process.env;
const repo = resolve(env.GITHUB_WORKSPACE || process.cwd());
const url = String(env.EVERYDECK_URL || '').replace(/\/$/, '');
const project = String(env.EVERYDECK_PROJECT || '');
const tmp = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'everydeck-check-'));
// The app map; an existing setup may still have it under its old name (read, never written)
const APP_MAP = ['everydeck/app-map.json', 'everydeck/everydeck-befund.json'].find((f) => existsSync(join(repo, f))) ?? 'everydeck/app-map.json';

const annotate = (level, msg, file) => process.stdout.write(`::${level}${file ? ` file=${file}` : ''} title=everydeck::${String(msg).replace(/\r?\n/g, '%0A')}\n`);
const summary = (md) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n'); else process.stdout.write(md + '\n'); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const runAsync = (cmd, args, opts = {}) => new Promise((res) => {
  const out = []; const err = [];
  const p = spawn(cmd, args, { cwd: repo, ...opts });
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
  p.on('error', (e) => res({ status: 1, stdout: '', stderr: String(e?.message ?? e) }));
  p.on('close', (status) => res({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
});
// How long each part took, in the summary of every run (the minutes are the owner's)
const t0 = Date.now(); let tLap = t0; const laps = [];
const lap = (name) => { const now = Date.now(); laps.push(`${name} ${((now - tLap) / 1000).toFixed(1)} s`); tLap = now; };
const timing = () => `Took ${((Date.now() - t0) / 1000).toFixed(1)} s (${laps.join(', ')}).`;
const finish = (code) => { process.stdout.write(`everydeck check: ${code === 0 ? 'green' : 'red'} (${timing()})\n`); process.exit(code); };

if (!url || !/^https?:\/\//.test(url) || !/^[0-9a-f-]{36}$/i.test(project)) { annotate('error', 'everydeck check needs the inputs url and project (see .github/workflows/everydeck.yml)'); finish(1); }
if (!existsSync(join(repo, APP_MAP))) { annotate('notice', `${APP_MAP} is not in this repository yet; nothing to check until everydeck is set up (your coding agent writes it).`); summary('### everydeck\n\nNothing to check yet: everydeck is not set up in this repository.'); finish(0); }

// 1. Tools from npm and PyPI in a fixed version, the same versions the public repository everydeck/everydeck publishes
const TOOLS = { scaffold: { name: '@everydeck/check', version: '0.3.22' }, check: { name: 'everydeck-check', version: '0.3.22' } };   // 0.3.22: no other worktrees or ignored folders in the scan, tables never from test scripts, what a review queue counts as open, its reason in the app's words, the pair and the page of the app; 0.3.21: tables the app empties itself (row_deletes); 0.3.20: false_positive per place, places and form on open parts, photo addresses (columns[].image_src), when reports, review queues and requests are done, a job without heartbeat is a note and a schedule in SQL needs none; 0.3.19: the inventory names where the app's own server reads its settings
let python = env.EVERYDECK_CHECK_PYTHON;
const pyEnv = {};
const tools = join(tmp, 'tools');
const needTs = !env.EVERYDECK_TYPESCRIPT_DIR && run(process.execPath, ['-e', "require.resolve('typescript')"]).status !== 0;   // the skeleton reads TS/JS through the TypeScript compiler API
// pip and npm at the same time; pip into a folder of its own (no virtual environment to create), a virtual environment only where the Python refuses that
const py = process.platform === 'win32' ? 'python' : 'python3';
const pkgDir = join(tmp, 'py');
const pipInto = (pyBin, target) => runAsync(pyBin, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-warn-script-location', ...(target ? ['--target', target] : []), `${TOOLS.check.name}==${TOOLS.check.version}`]);
const [pipTarget, npm] = await Promise.all([
  python ? Promise.resolve(null) : pipInto(py, pkgDir),
  runAsync('npm', ['install', '--loglevel', 'error', '--no-audit', '--no-fund', '--prefix', tools, `${TOOLS.scaffold.name}@${TOOLS.scaffold.version}`, ...(needTs ? ['typescript@5.9.3'] : [])]),
]);
if (!python && pipTarget.status === 0) { python = py; pyEnv.PYTHONPATH = pkgDir; }
else if (!python) {
  const venv = join(tmp, 'venv');
  if (run(py, ['-m', 'venv', venv]).status !== 0) { annotate('error', 'cannot create a Python environment for everydeck-check (Python ≥ 3.11 needed)'); finish(1); }
  python = join(venv, 'bin', 'python');
  const pip = await pipInto(python, null);
  if (pip.status !== 0) { annotate('error', `cannot install ${TOOLS.check.name}==${TOOLS.check.version} from PyPI: ${(pip.stderr || '').slice(-300)}`); finish(1); }
}
if (npm.status !== 0) { annotate('error', `cannot install ${TOOLS.scaffold.name}@${TOOLS.scaffold.version} from npm: ${(npm.stderr || npm.stdout || '').trim().split('\n').slice(0, 3).join(' ').slice(0, 300)}`); finish(1); }
lap('tools');
const skeleton = join(tools, 'node_modules', '@everydeck', 'check', 'scaffold.mjs');
const nodeEnv = { ...env, ...pyEnv };
if (env.EVERYDECK_TYPESCRIPT_DIR) nodeEnv.NODE_PATH = env.EVERYDECK_TYPESCRIPT_DIR;
else if (needTs) nodeEnv.NODE_PATH = join(tools, 'node_modules');
const check = (args) => run(python, ['-m', 'everydeck_check.cli', ...args], { env: nodeEnv });

// 2. Re-anchor (from the app map's commit to this commit), then the skeleton
const committed = JSON.parse(readFileSync(join(repo, APP_MAP), 'utf8'));
if (committed.commit && run('git', ['cat-file', '-e', `${committed.commit}^{commit}`]).status !== 0) run('git', ['fetch', '--no-tags', '--quiet', '--depth=1', 'origin', committed.commit]);
const anchored = join(tmp, 'app-map.anchored.json');
const ra = check(['reanchor', APP_MAP, '--repo', '.', '--out', anchored]);
const reanchor = jsonOf(ra);
if (!reanchor || reanchor.error) annotate('warning', `places of the app map were not re-anchored: ${reanchor?.error ?? (ra.stderr || '').slice(-200)}`);
const merged = join(tmp, 'app-map.json');
const sk = run(process.execPath, [skeleton, '.', '--merge', existsSync(anchored) ? anchored : join(repo, APP_MAP), '--out', merged], { env: nodeEnv });
if (sk.status !== 0 || !existsSync(merged)) { annotate('error', `the everydeck skeleton failed: ${(sk.stderr || '').slice(-400)}`); finish(1); }
const map = JSON.parse(readFileSync(merged, 'utf8'));
lap('app map');

// 3. Is every everydeck call still there?
// drift and validate read the same files and nothing of each other: at the same time
const [driftRun, validateRun] = await Promise.all([runAsync(python, ['-m', 'everydeck_check.cli', 'drift', merged, '--repo', '.'], { env: nodeEnv }), runAsync(python, ['-m', 'everydeck_check.cli', 'validate', merged, '--repo', '.'], { env: nodeEnv })]);
const dr = jsonOf(driftRun);
if (!dr) { annotate('error', 'everydeck-check drift did not answer'); finish(1); }
const flowOf = (sig) => (map.flows ?? []).find((f) => (f.signals ?? []).some((s) => s.name === sig))?.id;
const sentence = (f) => {
  const [path, symbol] = String(f.where).split('::');
  if (f.signal.startsWith('job:')) return `The heartbeat of job '${f.signal.slice(4)}' was removed in ${path}.`;
  if (f.signal.startsWith('screen:')) return `The page ${f.signal.slice(7)} is no longer passed to the everydeck browser SDK (initEverydeckBrowser({ screens })).`;
  if (f.signal.startsWith('api:')) return `The API route ${f.signal.slice(4)} is no longer passed to the everydeck browser SDK (initEverydeckBrowser({ apiRoutes })).`;
  const flow = flowOf(f.signal); const what = `Sending '${f.signal}'${flow ? ` (flow ${flow})` : ''}`;
  if (f.kind === 'missing_file') return `${what} was removed: ${path} no longer exists.`;
  if (f.kind === 'missing_symbol') return `${what} was removed: ${symbol ?? 'its function'} no longer exists in ${path}.`;
  if (f.kind === 'call_sites_decreased') { const [p2, rest] = String(f.where).split('::'); const [sym, counts] = String(rest).split(' '); return `${what} was removed in ${p2} (${sym}): ${counts} calls.`; }
  return `${what} was removed in ${path}${symbol ? ` (${symbol})` : ''}.`;
};
// A job that never had a heartbeat is a note (everydeck reads pg_cron itself or shows the job after its first run), never "removed"; a heartbeat the lock file
// knew and that is gone is sent as job_heartbeat_removed (everydeck treats the older kind job_not_in_heartbeat as unknown: those versions could not tell)
const notes = (dr.findings ?? []).filter((f) => f.kind === 'job_without_heartbeat').map((f) => f.signal.slice(4));
const findings = (dr.findings ?? []).filter((f) => f.kind !== 'new_build' && f.kind !== 'job_without_heartbeat').map((f) => ({ kind: f.kind === 'job_not_in_heartbeat' ? 'job_heartbeat_removed' : f.kind, sentence: sentence(f), ...(f.signal.includes(':') ? {} : { signal: f.signal, ...(flowOf(f.signal) ? { flow: flowOf(f.signal) } : {}) }), path: String(f.where).split('::')[0].split(' ')[0] }));
const red = findings.length > 0;

// Facts that no longer hold (not an everydeck call): not red, but everydeck turns them into a task for the agent
const va = jsonOf(validateRun);
lap('check');
// "database" places are checked only by a run with a database (--db); GitHub has none, so this is not an outdated fact
const openFacts = (va?.errors ?? []).filter((e) => !e.includes('run everydeck-check validate with --db')).slice(0, 200).map((e) => { const m = /^(.*?): (?:file )?([^\s:]+\.[A-Za-z0-9]+)(?::(\d+))?\b(.*)$/.exec(e); return { at: (m ? m[1] : e.split(':')[0]).slice(0, 300), path: (m ? m[2] : '').slice(0, 300), ...(m?.[3] ? { line: Number(m[3]) } : {}), reason: e.slice(0, 300) }; });

const sha = env.GITHUB_SHA || map.commit || '';
if (red) {
  for (const f of findings) annotate('error', f.sentence, f.path);
  summary([`### everydeck: an everydeck call is missing`, '', ...findings.map((f) => `- ${f.sentence}`), '', '#### Prompt for your coding agent', '', '```',
    `The everydeck check failed on ${sha.slice(0, 7)}: everydeck stops seeing these flows.`, ...findings.map((f) => `- ${f.sentence}`),
    'Put each call back where the flow\'s result is committed (everydeck/app-map.json names the flow, the signal and the function).',
    'If a flow was removed on purpose, remove it from the app map in the same change and run `everydeck-check drift everydeck/app-map.json --repo . --freeze`.',
    'Then push again.', '```'].join('\n'));
} else {
  summary([`### everydeck: all everydeck calls are in place`, '', `${map.tables?.length ?? 0} tables, ${map.screens?.length ?? 0} pages, ${(map.flows ?? []).length} flows.`,
    ...(reanchor && !reanchor.error ? [`Places re-anchored: ${reanchor.moved + reanchor.by_text + reanchor.by_symbol} moved, ${reanchor.unresolved.length} not found.`] : []),
    ...(notes.length ? ['', `${notes.length} scheduled job(s) send no heartbeat (${notes.slice(0, 5).join(', ')}${notes.length > 5 ? ', …' : ''}): everydeck shows them after their first run. That is fine; nothing to do.`] : []),
    ...(openFacts.length ? ['', `${openFacts.length} description(s) no longer match the code; everydeck asks your coding agent to update them:`, ...openFacts.slice(0, 10).map((f) => `- ${f.reason}`), ...(openFacts.length > 10 ? [`- … ${openFacts.length - 10} more`] : [])] : [])].join('\n'));
}

// Does the workflow run when a file with an everydeck call changes? (`paths` of the workflow; only paths go to everydeck, never code)
const guardFile = (() => {
  const path = /\/(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF || '')?.[1] ?? '.github/workflows/everydeck.yml';
  let text = ''; try { text = readFileSync(join(repo, path), 'utf8'); } catch { /* local run without the file */ }
  const wf = workflowFile(text);
  return { path, version: wf.version, filtered: wf.paths.length > 0, uncovered: wf.paths.length ? watchedFiles(repo, map).filter((f) => !covers(wf.paths, f)) : [] };
})();
if (guardFile.uncovered.length) {
  for (const f of guardFile.uncovered.slice(0, 10)) annotate('warning', `${f} has an everydeck call, but this check does not run when it changes: add it under paths (push and pull_request) in ${guardFile.path}.`, f);
  summary(['', `#### ${guardFile.uncovered.length} file(s) with an everydeck call are not under paths in ${guardFile.path}`, '', 'Add them to both lists, so a removed call is noticed in the pull request:', '', '```yaml', ...guardFile.uncovered.slice(0, 50).map((f) => `      - '${globOf(f)}'`), '```'].join('\n'));
}
summary(`\n${timing()}`);

// 4. Result to everydeck (OIDC); green after a push to the default branch, with the new app map
let event = {}; try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* local run without an event */ }
const defaultRef = event?.repository?.default_branch ? `refs/heads/${event.repository.default_branch}` : null;
const submit = !red && (env.GITHUB_EVENT_NAME === 'push' || env.GITHUB_EVENT_NAME === 'workflow_dispatch') && !!defaultRef && env.GITHUB_REF === defaultRef;
if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  annotate('warning', 'no OIDC token for this run (the workflow needs `permissions: id-token: write`; pull requests from forks get none); the result was not sent to everydeck.');
  finish(red ? 1 : 0);
}
try {
  const tu = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); tu.searchParams.set('audience', url);
  const tr = await fetch(tu, { headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  const id = (await tr.json())?.value;
  if (!id) throw new Error(`GitHub gave no OIDC token (${tr.status})`);
  const body = { project_id: project, result: red ? 'red' : 'green', submit, findings, open_facts: openFacts,
    guard_file: { version: guardFile.version, filtered: guardFile.filtered, uncovered: guardFile.uncovered.slice(0, 50) },
    ...(reanchor && !reanchor.error ? { reanchor: { moved: reanchor.moved, by_text: reanchor.by_text, by_symbol: reanchor.by_symbol, unresolved: reanchor.unresolved.length } } : {}), ...(submit ? { app_map: map } : {}) };
  const r = await fetch(`${url}/api/ci/github/runs`, { method: 'POST', headers: { authorization: `Bearer ${id}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status >= 400) annotate('warning', `everydeck did not accept the result (${r.status}): ${out.message ?? ''}`);
  else if (out.revision) summary(`\neverydeck took the new facts: ${out.revision.status === 'approved' ? 'adopted' : `waiting for the owner (${(out.revision.approval_reasons ?? []).join(', ')})`}.`);
  else if (out.refused) annotate('warning', `everydeck did not take the new facts: ${out.refused}`);
  writeFileSync(join(tmp, 'everydeck-answer.json'), JSON.stringify({ status: r.status, ...out }, null, 1));
  process.stdout.write(`everydeck answered ${r.status}${out.revision ? ` (revision ${out.revision.status})` : ''}\n`);
} catch (e) {
  annotate('warning', `everydeck is not reachable: ${e?.message ?? e}; the check result stands, nothing was sent.`);
}
finish(red ? 1 : 0);

