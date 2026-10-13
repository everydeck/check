#!/usr/bin/env node
/**
 * everydeck/check: the guard on every push. Runs on GitHub in the app's repository; everydeck never sees the code, only the result.
 *
 *   1. Provide the tools: the skeleton @everydeck/check from npm and the check everydeck-check from PyPI, each in a fixed version (TOOLS); no vendor/.
 *   2. Re-anchor places that moved (git, text, symbol: everydeck-check reanchor), then run the skeleton with --merge (new tables, pages, routes).
 *   3. Is every everydeck call still there? (everydeck-check drift against everydeck-manifest.lock.json) If one is missing, the check is red: one sentence per finding
 *      and the prompt for the coding agent in the check text.
 *   4. Send the result to everydeck (signed in with the run's OIDC token, no key); green after a push to the default branch: with the new Befund.
 *
 * Inputs (action.yml): EVERYDECK_URL, EVERYDECK_PROJECT. From GitHub: GITHUB_WORKSPACE, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_EVENT_PATH,
 * GITHUB_STEP_SUMMARY, RUNNER_TEMP, ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN (only with `permissions: id-token: write`).
 * For local runs: EVERYDECK_CHECK_PYTHON (Python with everydeck-check installed), EVERYDECK_TYPESCRIPT_DIR (node_modules with typescript); npm and pip
 * follow their own settings (npm_config_registry, PIP_INDEX_URL, PIP_FIND_LINKS).
 * If everydeck is unreachable the build does not break (warning); the check turns red only when an everydeck call is missing.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;
const repo = resolve(env.GITHUB_WORKSPACE || process.cwd());
const url = String(env.EVERYDECK_URL || '').replace(/\/$/, '');
const project = String(env.EVERYDECK_PROJECT || '');
const tmp = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'everydeck-check-'));
const BEFUND = 'everydeck/everydeck-befund.json';

const annotate = (level, msg, file) => process.stdout.write(`::${level}${file ? ` file=${file}` : ''} title=everydeck::${String(msg).replace(/\r?\n/g, '%0A')}\n`);
const summary = (md) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n'); else process.stdout.write(md + '\n'); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const finish = (code) => { process.stdout.write(`everydeck check: ${code === 0 ? 'green' : 'red'}\n`); process.exit(code); };

if (!url || !/^https?:\/\//.test(url) || !/^[0-9a-f-]{36}$/i.test(project)) { annotate('error', 'everydeck check needs the inputs url and project (see .github/workflows/everydeck.yml)'); finish(1); }
if (!existsSync(join(repo, BEFUND))) { annotate('notice', `${BEFUND} is not in this repository yet; nothing to check until everydeck is set up (your coding agent writes it).`); summary('### everydeck\n\nNothing to check yet: everydeck is not set up in this repository.'); finish(0); }

// 1. Tools from npm and PyPI in a fixed version, the same versions the public repository everydeck/everydeck publishes
const TOOLS = { scaffold: { name: '@everydeck/check', version: '0.2.1' }, check: { name: 'everydeck-check', version: '0.2.1' } };   // drift recognizes the relay from @everydeck/sdk
let python = env.EVERYDECK_CHECK_PYTHON;
if (!python) {
  const venv = join(tmp, 'venv');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (run(py, ['-m', 'venv', venv]).status !== 0) { annotate('error', 'cannot create a Python environment for everydeck-check (Python ≥ 3.11 needed)'); finish(1); }
  python = join(venv, 'bin', 'python');
  const pip = run(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', `${TOOLS.check.name}==${TOOLS.check.version}`]);
  if (pip.status !== 0) { annotate('error', `cannot install ${TOOLS.check.name}==${TOOLS.check.version} from PyPI: ${(pip.stderr || '').slice(-300)}`); finish(1); }
}
const tools = join(tmp, 'tools');
const needTs = !env.EVERYDECK_TYPESCRIPT_DIR && run(process.execPath, ['-e', "require.resolve('typescript')"]).status !== 0;   // the skeleton reads TS/JS through the TypeScript compiler API
const npm = run('npm', ['install', '--loglevel', 'error', '--no-audit', '--no-fund', '--prefix', tools, `${TOOLS.scaffold.name}@${TOOLS.scaffold.version}`, ...(needTs ? ['typescript@5.9.3'] : [])]);
if (npm.status !== 0) { annotate('error', `cannot install ${TOOLS.scaffold.name}@${TOOLS.scaffold.version} from npm: ${(npm.stderr || npm.stdout || '').trim().split('\n').slice(0, 3).join(' ').slice(0, 300)}`); finish(1); }
const skeleton = join(tools, 'node_modules', '@everydeck', 'check', 'befund-skeleton.mjs');
const nodeEnv = { ...env };
if (env.EVERYDECK_TYPESCRIPT_DIR) nodeEnv.NODE_PATH = env.EVERYDECK_TYPESCRIPT_DIR;
else if (needTs) nodeEnv.NODE_PATH = join(tools, 'node_modules');
const check = (args) => run(python, ['-m', 'everydeck_check.cli', ...args], { env: nodeEnv });

// 2. Re-anchor (from the Befund's commit to this commit), then the skeleton
const committed = JSON.parse(readFileSync(join(repo, BEFUND), 'utf8'));
if (committed.commit && run('git', ['cat-file', '-e', `${committed.commit}^{commit}`]).status !== 0) run('git', ['fetch', '--no-tags', '--quiet', '--depth=1', 'origin', committed.commit]);
const anchored = join(tmp, 'befund.anchored.json');
const ra = check(['reanchor', BEFUND, '--repo', '.', '--out', anchored]);
const reanchor = jsonOf(ra);
if (!reanchor || reanchor.error) annotate('warning', `places of the Befund were not re-anchored: ${reanchor?.error ?? (ra.stderr || '').slice(-200)}`);
const merged = join(tmp, 'befund.json');
const sk = run(process.execPath, [skeleton, '.', '--merge', existsSync(anchored) ? anchored : join(repo, BEFUND), '--out', merged], { env: nodeEnv });
if (sk.status !== 0 || !existsSync(merged)) { annotate('error', `the everydeck skeleton failed: ${(sk.stderr || '').slice(-400)}`); finish(1); }
const befund = JSON.parse(readFileSync(merged, 'utf8'));

// 3. Is every everydeck call still there?
const dr = jsonOf(check(['drift', merged, '--repo', '.']));
if (!dr) { annotate('error', 'everydeck-check drift did not answer'); finish(1); }
const flowOf = (sig) => (befund.flows ?? []).find((f) => (f.signals ?? []).some((s) => s.name === sig))?.id;
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
const findings = (dr.findings ?? []).filter((f) => f.kind !== 'new_build').map((f) => ({ kind: f.kind, sentence: sentence(f), ...(f.signal.includes(':') ? {} : { signal: f.signal, ...(flowOf(f.signal) ? { flow: flowOf(f.signal) } : {}) }), path: String(f.where).split('::')[0].split(' ')[0] }));
const red = findings.length > 0;

// Facts that no longer hold (not an everydeck call): not red, but everydeck turns them into a task for the agent
const va = jsonOf(check(['validate', merged, '--repo', '.']));
// "database" places are checked only by a run with a database (--db); GitHub has none, so this is not an outdated fact
const openFacts = (va?.errors ?? []).filter((e) => !e.includes('run everydeck-check validate with --db')).slice(0, 200).map((e) => { const m = /^(.*?): (?:file )?([^\s:]+\.[A-Za-z0-9]+)(?::(\d+))?\b(.*)$/.exec(e); return { at: (m ? m[1] : e.split(':')[0]).slice(0, 300), path: (m ? m[2] : '').slice(0, 300), ...(m?.[3] ? { line: Number(m[3]) } : {}), reason: e.slice(0, 300) }; });

const sha = env.GITHUB_SHA || befund.commit || '';
if (red) {
  for (const f of findings) annotate('error', f.sentence, f.path);
  summary([`### everydeck: an everydeck call is missing`, '', ...findings.map((f) => `- ${f.sentence}`), '', '#### Prompt for your coding agent', '', '```',
    `The everydeck check failed on ${sha.slice(0, 7)}: everydeck stops seeing these flows.`, ...findings.map((f) => `- ${f.sentence}`),
    'Put each call back where the flow\'s result is committed (everydeck/everydeck-befund.json names the flow, the signal and the function).',
    'If a flow was removed on purpose, remove it from the Befund in the same change and run `everydeck-check drift everydeck/everydeck-befund.json --repo . --freeze`.',
    'Then push again.', '```'].join('\n'));
} else {
  summary([`### everydeck: all everydeck calls are in place`, '', `${befund.tables?.length ?? 0} tables, ${befund.screens?.length ?? 0} pages, ${(befund.flows ?? []).length} flows.`,
    ...(reanchor && !reanchor.error ? [`Places re-anchored: ${reanchor.moved + reanchor.by_text + reanchor.by_symbol} moved, ${reanchor.unresolved.length} not found.`] : []),
    ...(openFacts.length ? ['', `${openFacts.length} description(s) no longer match the code; everydeck asks your coding agent to update them:`, ...openFacts.slice(0, 10).map((f) => `- ${f.reason}`), ...(openFacts.length > 10 ? [`- … ${openFacts.length - 10} more`] : [])] : [])].join('\n'));
}

// 4. Result to everydeck (OIDC); green after a push to the default branch, with the new Befund
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
    ...(reanchor && !reanchor.error ? { reanchor: { moved: reanchor.moved, by_text: reanchor.by_text, by_symbol: reanchor.by_symbol, unresolved: reanchor.unresolved.length } } : {}), ...(submit ? { befund } : {}) };
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
