// Commit extension import boundaries: a packet that changes plugin files under packages/plugins/ must not
// add a violation of the canonical boundary validator
// (scripts/testing/migrations/validateExtensionImportBoundaries.ts, owned by the plugin-boundary program).
// The validator reads manifests and public shared sources from a root directory, so each side (base and
// packet tree) is materialized from Git objects into a private temp root: other lanes' uncommitted
// worktree bytes never decide this packet's verdict. Changed files only; only violations the packet adds
// relative to its base refuse (one already at the base is reported by the validator's own CI lane).
// It also keeps apps/ui source out of the packages/tests TypeScript program (testsProgramUiImports below).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const VALIDATOR = fileURLToPath(new URL('../testing/migrations/validateExtensionImportBoundaries.ts', import.meta.url));
const SOURCE = /\.[cm]?[jt]sx?$/u;
const PLUGIN_ROOT = /^packages\/plugins\/[^/]+/u;

const nul = text => text.split('\0').filter(Boolean);

function gitIn(repo) {
  return (args, options = {}) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 2 ** 31 - 1, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

function readBlobs(git, oids) {
  const contents = new Map();
  if (!oids.length) return contents;
  const bytes = git(['cat-file', '--batch'], { input: Buffer.from(`${oids.join('\n')}\n`), encoding: 'buffer' });
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(10, offset);
    const [oid, , size] = bytes.subarray(offset, end).toString('utf8').split(' ');
    contents.set(oid, bytes.subarray(end + 1, end + 1 + Number(size)));
    offset = end + 1 + Number(size) + 1;
  }
  return contents;
}

// What the validator reads in changed-file mode: every packages/* and packages/plugins/* manifest, the
// sources of public (private: false) shared packages, and the changed plugin packages' sources.
function materialize(git, rev, pluginRoots, dir) {
  const entries = new Map();
  for (const record of nul(git(['ls-tree', '-r', '-z', '--full-tree', rev, '--', 'packages']))) {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') entries.set(record.slice(tab + 1), oid);
  }
  const manifests = [...entries.keys()].filter(path => /^packages\/(?:plugins\/)?[^/]+\/package\.json$/u.test(path));
  const manifestBlobs = readBlobs(git, manifests.map(path => entries.get(path)));
  const sourceRoots = [...pluginRoots].map(root => `${root}/src/`);
  for (const path of manifests) {
    if (path.startsWith('packages/plugins/')) continue;
    try {
      if (JSON.parse(manifestBlobs.get(entries.get(path)).toString('utf8')).private === false) sourceRoots.push(`${dirname(path)}/src/`);
    } catch {
      // An unparsable manifest is the validator's to report; it reads the same bytes.
    }
  }
  const selected = [...entries.keys()].filter(path => manifests.includes(path)
    || SOURCE.test(path) && sourceRoots.some(root => path.startsWith(root)));
  const blobs = readBlobs(git, [...new Set(selected.map(path => entries.get(path)))]);
  for (const path of selected) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), blobs.get(entries.get(path)));
  }
}

function violations(git, rev, pluginRoots, changedPluginFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'happier-commit-boundaries-'));
  try {
    const root = join(dir, 'root');
    mkdirSync(root);
    materialize(git, rev, pluginRoots, root);
    const list = join(dir, 'changed');
    writeFileSync(list, `${changedPluginFiles.join('\0')}\0`);
    try {
      execFileSync(process.execPath, [VALIDATOR, `--root-dir=${root}`, `--files-from0=${list}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 ** 31 - 1 });
      return [];
    } catch (error) {
      // Exit 1 is the validator's verdict; anything else is a broken check and fails closed.
      if (error.status !== 1 || !/Extension import boundary: FAILED/u.test(error.stderr ?? '')) {
        throw new Error(`extension import boundary validator failed (exit ${error.status}): ${String(error.stderr ?? error.message).slice(-600)}`);
      }
      return error.stderr.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The packages/tests program maps `@/*` to apps/cli, so an apps/ui source file it reaches fails every `@/...` import
// of its own and pulls in Expo's ambient globals (P03-TYPECHECK-DEBT 2026-11-17: ~6,000 of 7,239 new typecheck rows).
// UI code is reachable from that program only through the `.d.mts` facades (`@happier-tests/ui-*`); a composed test
// that needs real UI source leaves the program through the tsconfig `exclude`. Textual: changed program files only,
// relative specifiers only (the program's aliases point at apps/cli and the facades), and only imports the packet adds.
const TESTS_TSCONFIG = 'packages/tests/tsconfig.json';
const TESTS_UI_FINDING = 'packages/tests program imports apps/ui source (use a .d.mts facade or the tsconfig exclude)';
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/gu;

// tsconfig is JSONC: drop comments outside strings, then trailing commas.
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { const end = /^"(?:[^"\\]|\\.)*"/u.exec(text.slice(i))[0]; out += end; i += end.length - 1; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1'));
}

const matchesPattern = (path, pattern) => path === pattern || path.startsWith(`${pattern}/`) || posix.matchesGlob(path, pattern);

function uiImports(path, source, exists) {
  const found = new Set();
  for (const [, , spec] of source.matchAll(SPECIFIER)) {
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(path), spec));
    if (!target.startsWith('apps/ui/sources/')) continue;
    const stem = target.replace(/\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/u, '');
    if (target.endsWith('.d.mts') || exists(`${stem}.d.mts`)) continue;
    found.add(spec);
  }
  return found;
}

function testsProgramUiImports(git, base, tree, changed) {
  const candidates = changed.filter(path => path.startsWith('packages/tests/') && /\.[cm]?tsx?$/u.test(path));
  if (!candidates.length) return [];
  let config;
  try { config = parseJsonc(git(['show', `${tree}:${TESTS_TSCONFIG}`])); } catch { return []; }
  const local = path => path.slice('packages/tests/'.length);
  const inProgram = path => (config.include ?? []).some(pattern => matchesPattern(local(path), pattern))
    && !(config.exclude ?? []).some(pattern => matchesPattern(local(path), pattern));
  const show = (rev, path) => { try { return git(['show', `${rev}:${path}`]); } catch { return ''; } };
  const exists = path => { try { git(['cat-file', '-e', `${tree}:${path}`]); return true; } catch { return false; } };
  const findings = [];
  for (const path of candidates.filter(inProgram)) {
    const before = uiImports(path, show(base, path), exists);
    for (const spec of uiImports(path, show(tree, path), exists)) if (!before.has(spec)) findings.push(`${TESTS_UI_FINDING}: ${path} -> ${spec}`);
  }
  return findings;
}

export function commitExtensionBoundaries({ repo, base, tree }) {
  const git = gitIn(repo);
  const all = nul(git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=ACMRT', base, tree]));
  const findings = testsProgramUiImports(git, base, tree, all);
  const changed = nul(git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree]))
    .filter(path => PLUGIN_ROOT.test(path));
  if (!changed.length) return { findings };
  const pluginRoots = new Set(changed.map(path => path.match(PLUGIN_ROOT)[0]));
  const before = new Set(violations(git, base, pluginRoots, changed));
  return { findings: [...findings, ...violations(git, tree, pluginRoots, changed).filter(finding => !before.has(finding))] };
}
