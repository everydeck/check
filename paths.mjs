/**
 * everydeck/check: which files the workflow watches. GitHub starts the workflow only when a changed file matches a pattern under `paths` (push and
 * pull_request); a deleted or renamed file is matched by its name in the diff. This module reads those patterns from the workflow file and names the
 * files with an everydeck call that no pattern covers, so a removed call is never missed for long. Only paths go to everydeck, never code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The version of the workflow file (its first comment line; a file without it is the first version, which ran on every push) and its patterns */
export function workflowFile(text) {
  const version = Number(/^# everydeck check file v(\d+)/m.exec(text)?.[1] ?? 1);
  const paths = []; let inPaths = -1;
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*paths:\s*$/.test(line)) { inPaths = indent; continue; }
    const item = inPaths >= 0 && indent > inPaths ? /^\s*-\s*(?:'((?:[^']|'')*)'|"([^"]*)"|(\S+))\s*$/.exec(line) : null;
    if (item) { const p = item[1] !== undefined ? item[1].replace(/''/g, "'") : item[2] ?? item[3]; if (!paths.includes(p)) paths.push(p); continue; }
    if (line.trim()) inPaths = -1;
  }
  return { version, paths };
}

const esc = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** A pattern of `paths` (GitHub filter syntax: ** any path, * no slash, ? one character, a backslash escapes) as a regular expression */
export function globRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) { re += esc(p[++i]); continue; }
    if (ch === '*' && p[i + 1] === '*') { i++; if (p[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*'; continue; }
    if (ch === '*') { re += '[^/]*'; continue; }
    if (ch === '?') { re += '[^/]'; continue; }
    re += esc(ch);
  }
  return new RegExp(`^${re}$`);
}

/** Does the list start the workflow for this changed file? (in order; a pattern with ! takes a file out again, as GitHub does) */
export function covers(patterns, file) {
  let hit = false;
  for (const p of patterns) { const not = p.startsWith('!'); if (globRe(not ? p.slice(1) : p).test(file)) hit = !not; }
  return hit;
}

/** A file path as a pattern of exactly this file (the special characters of the filter syntax escaped, as in app/[id]/page.tsx) */
export const globOf = (f) => f.replace(/[*?+[\]!\\]/g, (ch) => `\\${ch}`);

/** Every file the check reads for an everydeck call: the call sites (everydeck-manifest.lock.json, the app map's signals), the places and schedules of
 *  the jobs, the SDK setup (adapters) and where the app names the signed-in person (identity), and any file that sets up the browser SDK or calls
 *  setSubject (the same markers as everydeck-check drift) */
const DEPENDENCY_FILES = /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|requirements[\w.-]*\.txt|go\.mod|Gemfile(?:\.lock)?|pubspec\.yaml)$/;
export function watchedFiles(repo, map) {
  const out = new Set();
  try { for (const k of Object.keys(JSON.parse(readFileSync(join(repo, 'everydeck-manifest.lock.json'), 'utf8')).call_sites ?? {})) { const p = k.slice(k.indexOf('@') + 1).split('::')[0]; if (p) out.add(p); } } catch { /* no lock yet */ }
  for (const f of map?.flows ?? []) for (const s of f.signals ?? []) { const p = s?.evidence?.path ?? s?.location?.path ?? s?.path ?? (typeof s?.where === 'string' ? s.where.split('::')[0] : null); if (p) out.add(p); }
  for (const j of map?.jobs ?? []) for (const ev of [j.evidence, j.every?.evidence]) if (ev?.path) out.add(ev.path);
  // the SDK setup and identity, not the package list (package.json, pyproject.toml): an update of other packages changes nothing the check reads
  const setup = [...(map?.adapters ?? []).map((a) => a?.evidence?.path), ...Object.values(map?.identity ?? {}).map((v) => v?.path)];
  for (const p of setup) if (typeof p === 'string' && !DEPENDENCY_FILES.test(p.split('/').pop())) out.add(p);
  const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.expo', 'everydeck', 'coverage', '__pycache__', '.venv']);
  const EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|dart|py|html)$/;
  const MARK = /initEverydeckBrowser|\.setSubject\(/;
  let seen = 0;
  const walk = (dir, rel) => {
    let names = []; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (SKIP.has(n) || seen > 20000) continue;
      const abs = join(dir, n); const r = rel ? `${rel}/${n}` : n;
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (!EXT.test(n) || st.size > 1_000_000) continue;
      seen++;
      try { if (MARK.test(readFileSync(abs, 'utf8'))) out.add(r); } catch { /* unreadable */ }
    }
  };
  walk(repo, '');
  return [...out].filter((f) => existsSync(join(repo, f))).sort();
}
