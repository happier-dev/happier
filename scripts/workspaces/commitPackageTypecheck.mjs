#!/usr/bin/env node
// Commit-time typecheck of the top-level `packages/*` workspaces a packet touches, plus their
// `packages/*` dependents (owner ruling 2026-11-15). It closes the class the textual producer
// closure cannot see: a consumer reading a field, id or type its uncommitted producer adds.
//
//   node scripts/workspaces/commitPackageTypecheck.mjs --base=<rev> --tree=<tree-ish>
//   node scripts/workspaces/commitPackageTypecheck.mjs <commit>...     (each against its first parent)
//
// Each package's authored source project (`tsconfig.json`) is compiled by the canonical compiler
// owner (runTypeScriptCli.mjs, with its declaration preparation) inside ONE persistent worktree per
// host and repository. The worktree keeps the compiler's incremental and declaration state between
// checks and is moved to each tree with `git read-tree --reset -u`; its dependencies are installed by
// the canonical dependency refresh that hstack-exec runs for the admitted payload. Results are cached
// per (tree, package): a tree's diagnostics are a function of its bytes, so a moved HEAD is just
// another tree, and the next candidate's parent is usually the tree checked last. Only diagnostics new
// relative to the parent count (commitTypeCoherenceDiagnostics owns that comparison). `packages/plugins/*`
// stays on the combined package runs.
//
// The rolling HEAD typecheck also follows apps/server, apps/cli and apps/ui, one scope each (own recorded
// HEAD, own admission identity via --projects, so the broker sizes each from its own recorded peak). An
// app scope compiles only when the range since its last check touches the app or a package it depends
// on, once per range (never per commit). Apps carry thousands of known errors, so their baseline is
// per file and error code: only a count increase is new, and it is bisected to the raising commit.
//
// Exit status: 0 no new diagnostics, nothing to check, or warn-only mode (COMMIT_PACKAGE_TYPECHECK_BLOCKING
// false: would-be refusals print `WARN`); when blocking, 1 for new diagnostics or a candidate compile that
// did not complete while its parent did, 2 for usage or runtime failure (fail closed).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilerDiagnosticFromLine } from '../testing/lib/compilerBaseline.mjs';
import { diagnosticHunks, newDiagnostics } from './commitTypeCoherenceDiagnostics.mjs';
import { WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, withWorkspaceBundleLock } from './workspaceBundleLock.mjs';

const COMPILER_INPUT = /\.(?:[cm]?[jt]sx?|json)$/u;
/** App workspaces the rolling HEAD typecheck follows, one scope each. */
export const ROLLING_APP_SCOPES = Object.freeze(['apps/server', 'apps/cli', 'apps/ui']);
const isAppScope = dir => ROLLING_APP_SCOPES.includes(dir);
const PACKAGE_PATH = /^packages\/([^/]+)\//u;
const GLOBAL_DIAGNOSTIC = /^error TS(\d+): (.+)$/u;
const nulList = text => text.split('\0').filter(Boolean);

// A committer's private index (GIT_INDEX_FILE) or repository overrides must never reach the
// worktree's own index: `read-tree --reset -u` would rewrite the caller's packet.
const gitEnv = () => {
  const env = { ...process.env };
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[name];
  return env;
};

function gitAt(repo) {
  return (args, options = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 2 ** 31 - 1, env: gitEnv(), ...options });
}

/** The packages/<name> workspaces whose source typecheck a packet can change, producers first. */
export function commitTypecheckPackages({ repo, base, tree }) {
  const git = gitAt(repo);
  const changed = nulList(git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree]));
  if (!changed.some(path => path.startsWith('packages/'))) return { touched: [], packages: [] };
  const names = nulList(git(['ls-tree', '-z', '--name-only', `${tree}:packages`]));
  const specs = names.flatMap(name => [`${tree}:packages/${name}/package.json`, `${tree}:packages/${name}/tsconfig.json`]);
  // One batched object read: `<spec> missing` for absent paths, otherwise header + blob.
  const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, env: gitEnv(), input: `${specs.join('\n')}\n`, maxBuffer: 2 ** 31 - 1 });
  const blobs = [];
  for (let offset = 0; offset < batch.length;) {
    const headerEnd = batch.indexOf(10, offset);
    const header = batch.subarray(offset, headerEnd).toString('utf8');
    if (header.endsWith(' missing')) { blobs.push(undefined); offset = headerEnd + 1; continue; }
    const size = Number(header.split(' ')[2]);
    blobs.push(batch.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8'));
    offset = headerEnd + 1 + size + 1;
  }
  const packages = new Map();
  for (const [index, name] of names.entries()) {
    const [manifestText, config] = [blobs[index * 2], blobs[index * 2 + 1]];
    if (name === 'plugins' || manifestText === undefined || config === undefined) continue;
    const manifest = JSON.parse(manifestText);
    if (!manifest.scripts?.typecheck) continue;
    packages.set(manifest.name, { dir: `packages/${name}`, dependencies: Object.keys({ ...manifest.dependencies,
      ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }) });
  }
  const byDir = new Map([...packages].map(([name, entry]) => [entry.dir, name]));
  const touched = new Set(changed.filter(path => COMPILER_INPUT.test(path))
    .map(path => PACKAGE_PATH.exec(path)?.[1]).filter(name => name && name !== 'plugins')
    .map(name => byDir.get(`packages/${name}`)).filter(Boolean));
  // Dependents read the touched package's types: a producer change can break them without
  // touching them (2026-11-15: a Protocol schema union broke plugin-sdk hostingOperationActions).
  const selected = new Set(touched);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, entry] of packages) {
      if (!selected.has(name) && entry.dependencies.some(dependency => selected.has(dependency))) {
        selected.add(name);
        grew = true;
      }
    }
  }
  const ordered = [];
  const visit = (name, path = new Set()) => {
    if (ordered.includes(name) || path.has(name)) return;
    path.add(name);
    for (const dependency of packages.get(name).dependencies) if (selected.has(dependency)) visit(dependency, path);
    path.delete(name);
    ordered.push(name);
  };
  for (const name of [...selected].sort()) visit(name);
  return {
    touched: [...touched].map(name => packages.get(name).dir).sort(),
    packages: ordered.map(name => packages.get(name).dir),
  };
}

/** The rolling app scopes a range can change: the app's own compiler inputs, or a packages/* workspace
 * it depends on directly or through the packages/* producers of that dependency. */
export function commitTypecheckApps({ repo, base, tree }) {
  const git = gitAt(repo);
  const changed = nulList(git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree])).filter(path => COMPILER_INPUT.test(path));
  if (!changed.length) return [];
  // Package names whose sources changed, plus the packages/* dependents commitTypecheckPackages selects.
  const packageDirs = new Set(commitTypecheckPackages({ repo, base, tree }).packages);
  for (const path of changed) {
    const match = /^packages\/(?:plugins\/)?([^/]+)\//u.exec(path);
    if (match) packageDirs.add(path.startsWith('packages/plugins/') ? `packages/plugins/${match[1]}` : `packages/${match[1]}`);
  }
  const nameOf = dir => { try { return JSON.parse(git(['show', `${tree}:${dir}/package.json`])).name; } catch { return undefined; } };
  const changedNames = new Set([...packageDirs].map(nameOf).filter(Boolean));
  return ROLLING_APP_SCOPES.filter(dir => {
    let manifest;
    try { manifest = JSON.parse(git(['show', `${tree}:${dir}/package.json`])); } catch { return false; }
    if (changed.some(path => path.startsWith(`${dir}/`))) return true;
    return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })
      .some(name => changedNames.has(name));
  });
}

/** One state directory per host and repository: the warm worktree, its lock and the result cache. */
export function commitPackageTypecheckStateDir(repo, env = process.env) {
  if (env.HAPPIER_COMMIT_TYPECHECK_DIR) return resolve(env.HAPPIER_COMMIT_TYPECHECK_DIR);
  const common = realpathSync(resolve(repo, gitAt(repo)(['rev-parse', '--git-common-dir']).trim()));
  const slug = `${basename(resolve(common, '..'))}-${createHash('sha256').update(common).digest('hex').slice(0, 12)}`;
  return join(homedir(), '.happier-stack', 'cache', 'commit-typecheck', slug);
}

function ensureWorktree(repo, worktree) {
  if (existsSync(join(worktree, '.git'))) return;
  mkdirSync(resolve(worktree, '..'), { recursive: true });
  const git = gitAt(repo);
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--detach', worktree, 'HEAD']);
  // Locked so a `git worktree prune` elsewhere never drops the warm state's registration.
  git(['worktree', 'lock', '--reason', 'commit package typecheck (scripts/workspaces/commitPackageTypecheck.mjs)', worktree]);
}

/** Parses compiler output; `null` when the compiler did not finish with a verdict. */
export function packageTypecheckRows(result, cwd, rootDir) {
  if (result.error || result.signal || ![0, 1, 2].includes(result.status)) return null;
  const rows = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    const located = compilerDiagnosticFromLine(line, cwd, rootDir);
    if (located) rows.push({ file: located.file, line: located.line, column: located.column, code: located.code, text: located.message });
    const global = GLOBAL_DIAGNOSTIC.exec(line);
    if (global) rows.push({ file: '<global>', line: 0, column: 0, code: Number(global[1]), text: global[2] });
  }
  if (result.status !== 0 && rows.length === 0) return null;
  return rows;
}

function compilePackage(worktree, dir, env) {
  const cwd = join(worktree, dir);
  const output = mkdtempSync(join(tmpdir(), 'happier-commit-typecheck-'));
  const descriptors = [openSync(join(output, 'stdout'), 'w'), openSync(join(output, 'stderr'), 'w')];
  const started = Date.now();
  try {
    // Regular files, not pipes: a compiler descendant can keep a pipe open after the compiler exits.
    const result = spawnSync(process.execPath, [join(worktree, 'scripts/workspaces/runTypeScriptCli.mjs'),
      '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], { cwd, env, stdio: ['ignore', ...descriptors] });
    const stdout = readFileSync(join(output, 'stdout'), 'utf8');
    const stderr = readFileSync(join(output, 'stderr'), 'utf8');
    return { rows: packageTypecheckRows({ ...result, stdout, stderr }, cwd, worktree), ms: Date.now() - started,
      failure: `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}${result.error ? ` error=${result.error.code}` : ''}`,
      tail: stderr.split(/\r?\n/u).filter(line => line.startsWith('[typecheck-')).slice(-3) };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(output, { recursive: true, force: true });
  }
}

/** The app's own finite source typecheck (its `typecheck:source:finite` compiler step, without the
 * generated-input checks chained before it), through the canonical compiler owner. */
function compileApp(worktree, dir, env) {
  const cwd = join(worktree, dir);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const script = String(manifest.scripts?.['typecheck:source:finite'] ?? manifest.scripts?.['typecheck:local'] ?? '');
  const step = script.split('&&').map(part => part.trim()).find(part => /runTypeScriptCli\.mjs/u.test(part));
  if (!step) return { rows: null, ms: 0, failure: 'no runTypeScriptCli step in typecheck:source:finite' };
  const [program, ...args] = step.split(/\s+/u);
  if (program !== 'node') return { rows: null, ms: 0, failure: `unsupported typecheck step ${program}` };
  const output = mkdtempSync(join(tmpdir(), 'happier-commit-typecheck-'));
  const descriptors = [openSync(join(output, 'stdout'), 'w'), openSync(join(output, 'stderr'), 'w')];
  const started = Date.now();
  try {
    // HAPPIER_TYPECHECK_REPORT_DIR makes the compiler owner print plain (--pretty false) diagnostics.
    const reports = join(output, 'reports');
    mkdirSync(reports);
    const result = spawnSync(process.execPath, args, { cwd, env: { ...env, HAPPIER_TYPECHECK_REPORT_DIR: reports }, stdio: ['ignore', ...descriptors] });
    const stdout = readFileSync(join(output, 'stdout'), 'utf8');
    const stderr = readFileSync(join(output, 'stderr'), 'utf8');
    return { rows: packageTypecheckRows({ ...result, stdout, stderr }, cwd, worktree), ms: Date.now() - started,
      failure: `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}${result.error ? ` error=${result.error.code}` : ''}`,
      tail: stderr.split(/\r?\n/u).filter(line => line.startsWith('[typecheck-')).slice(-3) };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(output, { recursive: true, force: true });
  }
}
const compileScope = (worktree, dir, env) => (isAppScope(dir) ? compileApp : compilePackage)(worktree, dir, env);

const resultCachePath = (state, treeId, dir) => join(state, 'results', treeId, `${dir.replaceAll('/', '__')}.json`);

/** Rows per (tree, package) from the result cache, compiling the missing ones in the warm worktree.
 * The caller holds the worktree lock and, when anything compiles, compiler admission. */
function treeTypechecker({ repo, state, env, log, compile = compileScope, bootstrap }) {
  const git = gitAt(repo);
  const worktree = join(state, 'worktree');
  const compileEnv = { ...env };
  delete compileEnv.HAPPIER_TYPECHECK_REPORT_DIR;
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete compileEnv[name];
  const install = bootstrap ?? (() => execFileSync(process.execPath, [join(worktree, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs'),
    '--validation-kind=typecheck', '--component-relative-dir=', `--repo-dir=${worktree}`, '--execution-placement=local'],
  { cwd: worktree, env: compileEnv, stdio: ['ignore', 'ignore', 'inherit'] }));
  const timings = [];
  const rowsAt = (treeId, packages, side = treeId.slice(0, 10)) => {
    const rows = new Map();
    const missing = [];
    for (const dir of packages) {
      try { rows.set(dir, JSON.parse(readFileSync(resultCachePath(state, treeId, dir), 'utf8')).rows); } catch { missing.push(dir); }
    }
    if (!missing.length) return rows;
    ensureWorktree(repo, worktree);
    const moveStarted = Date.now();
    const currentPath = join(state, 'worktree-tree');
    const current = existsSync(currentPath) ? readFileSync(currentPath, 'utf8').trim() : '';
    writeFileSync(currentPath, '');
    gitAt(worktree)(['read-tree', '--reset', '-u', treeId]);
    writeFileSync(currentPath, treeId);
    timings.push({ side, step: 'move', ms: Date.now() - moveStarted });
    // Dependencies: the canonical bootstrap owner (the one hstack-exec runs before typecheck
    // payloads). It costs ~6 s even when current, so it runs only when dependency inputs moved.
    if (!current || !existsSync(join(worktree, 'node_modules'))
      || git(['diff', '--name-only', current, treeId, '--', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches', '*package.json']).trim()) {
      const bootstrapStarted = Date.now();
      install();
      timings.push({ side, step: 'dependencies', ms: Date.now() - bootstrapStarted });
    }
    for (const dir of missing) {
      const compiled = compile(worktree, dir, compileEnv);
      timings.push({ side, step: dir, ms: compiled.ms, complete: Boolean(compiled.rows) });
      log(`[commit-package-typecheck] ${side} ${dir} ${(compiled.ms / 1000).toFixed(1)}s ${compiled.rows ? `${compiled.rows.length} diagnostics` : `incomplete ${compiled.failure} ${compiled.tail?.join(' | ') ?? ''}`}`);
      rows.set(dir, compiled.rows);
      if (!compiled.rows) continue;
      const path = resultCachePath(state, treeId, dir);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({ tree: treeId, package: dir, rows: compiled.rows, ms: compiled.ms }));
      renameSync(`${path}.tmp`, path);
    }
    return rows;
  };
  return { rowsAt, timings };
}

/** App baseline: per file and error code. Where the head has more rows than the base, the excess (its
 * last rows in source order) is new; line moves never are. Monotone, so bisection can find the raising commit. */
function countIncreases(base, head) {
  const key = row => `${row.file}\0${row.code}`;
  const baseCounts = new Map();
  for (const row of base) baseCounts.set(key(row), (baseCounts.get(key(row)) ?? 0) + 1);
  const groups = new Map();
  for (const row of head) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  const fresh = [];
  for (const [group, rows] of groups) {
    const excess = rows.length - (baseCounts.get(group) ?? 0);
    if (excess > 0) fresh.push(...[...rows].sort((a, b) => a.line - b.line || a.column - b.column).slice(-excess));
  }
  return fresh;
}

/** The head rows (same objects) new against the base, per package (commitTypeCoherenceDiagnostics owns the comparison). */
function freshBetween(git, baseTree, headTree, packages, baseRows, headRows) {
  // Hunks only for files the range changes; unchanged files keep every position.
  const changedFiles = new Set(nulList(git(['diff', '--name-only', '-z', '--no-renames', baseTree, headTree])));
  const fresh = [];
  const incomplete = [];
  const unavailable = [];
  for (const dir of packages) {
    const base = baseRows.get(dir);
    const head = headRows.get(dir);
    // A head compile that does not finish while its base's does is the change's doing. Without a
    // complete base nothing can be judged: every head diagnostic would look new.
    if (!head) { (base ? incomplete : unavailable).push(dir); continue; }
    if (!base) { unavailable.push(dir); continue; }
    if (isAppScope(dir)) { for (const row of countIncreases(base, head)) fresh.push({ dir, row }); continue; }
    const files = new Set(base.map(row => row.file).filter(file => changedFiles.has(file)));
    const hunks = new Map([...files].map(file => [file, diagnosticHunks(git(['diff', '--no-ext-diff', '--no-textconv',
      '--no-color', '--no-renames', '--unified=0', baseTree, headTree, '--', file]))]));
    for (const row of newDiagnostics(base, head, hunks)) fresh.push({ dir, row });
  }
  return { fresh, incomplete, unavailable };
}

/**
 * Typechecks the packages a packet touches in the warm worktree and returns the diagnostics the
 * candidate adds. The caller must already hold compiler admission (the CLI acquires it).
 */
export async function commitPackageTypecheck({ repo, base, tree, env = process.env, log = message => process.stderr.write(`${message}\n`) }) {
  const started = Date.now();
  const git = gitAt(repo);
  const selection = commitTypecheckPackages({ repo, base, tree });
  if (!selection.packages.length) return { ...selection, skipped: true, fresh: [], incomplete: [], unavailable: [], timings: [], ms: Date.now() - started };
  const trees = { base: git(['rev-parse', `${base}^{tree}`]).trim(), head: git(['rev-parse', `${tree}^{tree}`]).trim() };
  const state = commitPackageTypecheckStateDir(repo, env);
  const locked = async action => env.HAPPIER_COMMIT_TYPECHECK_LOCKED === '1' ? await action()
    : await withWorkspaceBundleLock(action, { lockPath: join(state, 'worktree.lock'), timeoutMs: null });
  return await locked(async () => {
    const lockWaitMs = Date.now() - started;
    const { rowsAt, timings } = treeTypechecker({ repo, state, env, log });
    const baseRows = rowsAt(trees.base, selection.packages, 'base');
    const headRows = rowsAt(trees.head, selection.packages, 'head');
    const compared = freshBetween(git, trees.base, trees.head, selection.packages, baseRows, headRows);
    const fresh = compared.fresh.map(({ dir, row }) => ({ ...row, package: dir }));
    return { ...selection, skipped: false, trees, fresh, incomplete: compared.incomplete, unavailable: compared.unavailable, timings, lockWaitMs, ms: Date.now() - started };
  });
}


/** True when both trees' results for every selected package are cached (no compiler needed). */
export function commitPackageTypecheckCached({ repo, base, tree, env = process.env }) {
  const git = gitAt(repo);
  const state = commitPackageTypecheckStateDir(repo, env);
  const { packages } = commitTypecheckPackages({ repo, base, tree });
  return [base, tree].every(rev => {
    const treeId = git(['rev-parse', `${rev}^{tree}`]).trim();
    return packages.every(dir => existsSync(resultCachePath(state, treeId, dir)));
  });
}

/** Human-readable verdict lines; also what committers see when a packet is refused. */
export function formatCommitPackageTypecheck(result) {
  if (result.skipped) return ['package typecheck: skipped (no packages/* source touched)'];
  const lines = [`package typecheck: ${result.packages.join(', ')} new=${result.fresh.length} incomplete=${result.incomplete.length} unavailable=${result.unavailable.length} ${(result.ms / 1000).toFixed(1)}s`];
  for (const row of result.fresh) lines.push(`  ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text}`);
  for (const dir of result.incomplete) lines.push(`  ${dir}: the candidate's typecheck did not complete (its parent's did)`);
  for (const dir of result.unavailable) lines.push(`  ${dir}: typecheck unavailable (neither parent nor candidate completed); not counted`);
  return lines;
}

export const commitPackageTypecheckRefuses = result => !result.skipped && (result.fresh.length > 0 || result.incomplete.length > 0);

const BOARD = '.project/reviews/2026-10-02-lane12-replan/HANDOFF-OTHER-PROGRAMS.md';
const ROLLING_HEAD = 'rolling-head';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The lane that posted the commit's SHA on the board (its oldest mention); otherwise P03 ORCH. */
export function commitLane(commit, boardPaths) {
  const short = commit.slice(0, 10);
  let lane;
  for (const path of boardPaths) {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    let sender;
    for (const line of text.split('\n')) {
      const heading = /^### .*? UTC — (.+?) → /u.exec(line);
      if (heading) sender = heading[1].replace(/\s*\(.*\)$/u, '').trim();
      // The board is newest first: the last mention is the earliest, normally the committing lane's.
      if (sender && line.includes(short)) lane = sender;
    }
    if (lane) return lane;
  }
  return undefined;
}

function urgentEntry({ commit, subject, lane, rows, base, head }) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const addressees = lane && lane !== 'P03 ORCH' ? `${lane}, P03 ORCH` : 'P03 ORCH';
  return [
    `### ${stamp} UTC — P03-COMMIT-CHECKS → ${addressees} — URGENT — new type errors from ${commit.slice(0, 11)}`,
    `- ${lane ? `${lane}: fix forward` : 'P03 ORCH: route to the author'}: the rolling HEAD typecheck attributes ${rows.length} new error(s) to \`${commit.slice(0, 11)}\` ("${subject}") by bisecting ${base.slice(0, 11)}..${head.slice(0, 11)}.`,
    ...rows.slice(0, 8).map(row => `  - ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text.replace(/\s+/gu, ' ').slice(0, 200)}`),
    ...(rows.length > 8 ? [`  - … ${rows.length - 8} more: \`node scripts/workspaces/commitPackageTypecheck.mjs ${commit.slice(0, 11)}\``] : []),
    '',
  ].join('\n');
}

function postBoardEntry(repo, entry) {
  const temp = mkdtempSync(join(tmpdir(), 'happier-rolling-typecheck-post-'));
  try {
    writeFileSync(join(temp, 'entry.md'), entry);
    execFileSync(process.execPath, [join(repo, 'scripts/board/postBoardEntry.mjs'), join(repo, BOARD), join(temp, 'entry.md')], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Each scope records its own last checked HEAD; the packages scope keeps its original file. */
const rollingHeadPath = (state, scope) => join(state, scope === 'packages' ? ROLLING_HEAD : `${ROLLING_HEAD}-${scope.replaceAll('/', '__')}`);
const rollingScopeDirs = ({ repo, base, head, scope }) => scope === 'packages'
  ? commitTypecheckPackages({ repo, base, tree: head }).packages
  : commitTypecheckApps({ repo, base, tree: head }).filter(dir => dir === scope);

/** The last checked HEAD; without a usable one (first run, rewritten history) the newest commit's parent. */
function rollingBase(repo, recorded, head) {
  const ancestor = recorded && spawnSync('git', ['merge-base', '--is-ancestor', recorded, head], { cwd: repo, env: gitEnv() }).status === 0;
  return ancestor ? recorded : gitAt(repo)(['rev-parse', `${head}^`]).trim();
}

/**
 * One pass of the rolling HEAD typecheck (owner ruling 2026-11-15; replaces the per-commit warn-only
 * checks). It typechecks the newest HEAD against the last HEAD it checked, so every commit in between
 * is covered by one compile; only when that adds diagnostics does it bisect the first-parent range to
 * the commit that introduced each one, and post one board URGENT per introducing commit. The checked
 * HEAD then becomes the baseline, red or green, so a known error is reported once.
 * The caller holds the worktree lock and, when anything compiles, compiler admission.
 */
export async function rollingHeadTypecheckPass({ repo, env = process.env, log = message => process.stderr.write(`${message}\n`),
  compile, bootstrap, post = entry => postBoardEntry(repo, entry), boardPaths = [join(repo, BOARD)], scope = 'packages' }) {
  const started = Date.now();
  const git = gitAt(repo);
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(state, { recursive: true });
  const head = git(['rev-parse', 'HEAD']).trim();
  const recordedPath = rollingHeadPath(state, scope);
  const recorded = existsSync(recordedPath) ? readFileSync(recordedPath, 'utf8').trim() : '';
  const result = { scope, base: recorded, head, attributions: [], incomplete: [], unavailable: [], packages: [] };
  if (recorded === head) return result;
  const base = rollingBase(repo, recorded, head);
  result.base = base;
  const record = verdict => {
    writeFileSync(`${recordedPath}.tmp`, head);
    renameSync(`${recordedPath}.tmp`, recordedPath);
    appendFileSync(join(state, 'verdicts.log'), `${new Date().toISOString()} ROLLING-${verdict} scope=${scope} base=${base} head=${head} packages=${result.packages.join(',') || '-'} new=${result.attributions.reduce((sum, entry) => sum + entry.rows.length, 0)} incomplete=${result.incomplete.join(',') || '-'} unavailable=${result.unavailable.join(',') || '-'} ${((Date.now() - started) / 1000).toFixed(1)}s${result.attributions.map(entry => ` | ${entry.commit.slice(0, 11)}: ${entry.rows.length}`).join('')}\n`);
  };
  const packages = rollingScopeDirs({ repo, base, head, scope });
  result.packages = packages;
  if (!packages.length) { record('skipped'); return result; }
  const treeOf = commit => git(['rev-parse', `${commit}^{tree}`]).trim();
  const { rowsAt } = treeTypechecker({ repo, state, env, log, compile, bootstrap });
  const headTree = treeOf(head);
  const headRows = rowsAt(headTree, packages, 'head');
  const compared = freshBetween(git, treeOf(base), headTree, packages, rowsAt(treeOf(base), packages, 'base'), headRows);
  result.incomplete = compared.incomplete;
  result.unavailable = compared.unavailable;
  if (!compared.fresh.length) { record(compared.incomplete.length ? 'INCOMPLETE' : 'ok'); return result; }
  // Bisect, only when red. A diagnostic exists at a commit when it is not new at HEAD relative to that commit.
  const commits = git(['rev-list', '--first-parent', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  const presentAt = (commit, items) => {
    const tree = treeOf(commit);
    if (tree === headTree) return new Set(items);
    const atCommit = rowsAt(tree, packages, commit.slice(0, 10));
    const newAtHead = new Set(freshBetween(git, tree, headTree, packages, atCommit, headRows).fresh.map(({ row }) => row));
    return new Set(items.filter(item => atCommit.get(item.dir) && !newAtHead.has(item.row)));
  };
  let remaining = compared.fresh;
  for (let low = 0; remaining.length;) {
    let [a, b] = [low, commits.length - 1];
    while (a < b) {
      const middle = (a + b) >> 1;
      if (presentAt(commits[middle], remaining).size) b = middle; else a = middle + 1;
    }
    const here = presentAt(commits[a], remaining);
    result.attributions.push({ commit: commits[a], rows: [...here].map(({ dir, row }) => ({ ...row, package: dir })) });
    remaining = remaining.filter(item => !here.has(item));
    low = a + 1;
  }
  for (const entry of result.attributions) {
    const subject = git(['log', '-1', '--format=%s', entry.commit]).trim();
    try { post(urgentEntry({ ...entry, subject, lane: commitLane(entry.commit, boardPaths), base, head })); }
    catch (error) { log(`[rolling-head-typecheck] board post failed for ${entry.commit.slice(0, 11)}: ${error?.message ?? error}`); }
  }
  record('RED');
  return result;
}

/**
 * Commit paths call this after HEAD moved (commit-partial.sh, commitFromPrivateIndex, the coherence
 * finalizer). It never waits: it starts the single rolling owner detached, which exits at once when a
 * check already holds the warm worktree (that holder re-reads HEAD before it lets go).
 */
export function kickRollingHeadTypecheck({ repo, env = process.env }) {
  // A repository without typecheckable packages/* (test fixtures) has nothing to follow.
  if (!commitTypecheckPackages({ repo, base: EMPTY_TREE, tree: 'HEAD' }).packages.length
    && !commitTypecheckApps({ repo, base: EMPTY_TREE, tree: 'HEAD' }).length) return 'rolling HEAD typecheck: no packages/* or apps to check';
  const childEnv = { ...env };
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete childEnv[name];
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(join(state, 'runs'), { recursive: true });
  const descriptor = openSync(join(state, 'runs', 'rolling.log'), 'a');
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--rolling'], { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', descriptor, descriptor] }).unref();
  } finally {
    closeSync(descriptor);
  }
  return `rolling HEAD typecheck kicked; verdicts in ${join(state, 'verdicts.log')}`;
}

function admittedCommand(repo, payload, cached, projects) {
  // Native Windows has no shell admission; it runs the payload directly (as the checker does).
  // The admitted argv is the admission identity: only stable arguments, so the broker sizes it from
  // this identity's recorded kernel peak; the request travels in env.
  return cached || process.platform === 'win32' ? payload : [fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)),
    '--heavyweight-admission', '--class=compilation', `--machine=${process.env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
    ...(projects ? [`--projects=${projects}`] : []), '--exec-admitted', '--', ...payload];
}

async function rolling(repo) {
  const state = commitPackageTypecheckStateDir(repo);
  const worktree = join(state, 'worktree');
  const scopes = ['packages', ...ROLLING_APP_SCOPES];
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: gitEnv() }).trim();
  const recorded = scope => { const path = rollingHeadPath(state, scope); return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''; };
  const behind = () => scopes.filter(scope => recorded(scope) !== head());
  const payload = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), '--compiler-admitted'];
  for (;;) {
    try {
      await withWorkspaceBundleLock(async () => {
        // Packages first (fast, blocking-relevant), then each app; HEAD is re-read after every pass.
        for (let pending = behind(); pending.length; pending = behind()) {
          let progressed = false;
          for (const scope of pending) {
            const before = recorded(scope);
            ensureWorktree(repo, worktree);
            const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_ROLLING: '1', HAPPIER_COMMIT_TYPECHECK_REPO: repo,
              HAPPIER_COMMIT_TYPECHECK_LOCKED: '1', HAPPIER_COMMIT_TYPECHECK_SCOPE: scope };
            // A range with nothing to compile for this scope needs no admission slot.
            const current = head();
            const idle = !rollingScopeDirs({ repo, base: rollingBase(repo, before, current), head: current, scope }).length;
            const command = admittedCommand(repo, payload, idle, scope === 'packages' ? undefined : scope);
            const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env, stdio: 'inherit' });
            if (result.error) throw result.error;
            if (recorded(scope) === before) console.error(`[rolling-head-typecheck] ${scope} pass exit=${result.status} recorded nothing; waiting for the next HEAD move`);
            else progressed = true;
          }
          // A round that could record nothing must not spin on the same HEAD; the next commit kicks again.
          if (!progressed) return;
        }
      }, { lockPath: join(state, 'worktree.lock'), timeoutMs: null, wait: false });
    } catch (error) {
      if (error?.code === WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) return 0; // the holder re-reads HEAD before releasing
      throw error;
    }
    // Closes the window between the holder's last HEAD read and its release.
    if (!behind().length) return 0;
  }
}

async function main(argv) {
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[name];
  if (argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_ROLLING === '1') {
    const result = await rollingHeadTypecheckPass({ repo: process.env.HAPPIER_COMMIT_TYPECHECK_REPO,
      scope: process.env.HAPPIER_COMMIT_TYPECHECK_SCOPE || 'packages' });
    console.log(`[rolling-head-typecheck] ${result.scope} ${result.base.slice(0, 11)}..${result.head.slice(0, 11)} packages=${result.packages.length} attributions=${result.attributions.map(entry => `${entry.commit.slice(0, 11)}:${entry.rows.length}`).join(',') || 'none'}`);
    return 0;
  }
  const admitted = argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST;
  if (admitted) {
    const repo = process.env.HAPPIER_COMMIT_TYPECHECK_REPO;
    let refused = 0;
    for (const target of JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST)) {
      const result = await commitPackageTypecheck({ repo, base: target.base, tree: target.tree });
      if (commitPackageTypecheckRefuses(result)) refused += 1;
      console.log(`${commitPackageTypecheckRefuses(result) ? 'INCOHERENT' : 'coherent'} ${target.label}: ${formatCommitPackageTypecheck(result).join('\n')}`);
      console.log(`[commit-package-typecheck-timings] ${JSON.stringify({ label: target.label, lockWaitMs: result.lockWaitMs, ms: result.ms, timings: result.timings })}`);
    }
    return refused ? 1 : 0;
  }
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (argv.includes('--kick')) { console.log(kickRollingHeadTypecheck({ repo })); return 0; }
  if (argv.includes('--rolling')) return await rolling(repo);
  // By hand: one or more packets, each against its parent (or --base/--tree).
  const rev = spec => execFileSync('git', ['rev-parse', '--verify', spec], { cwd: repo, encoding: 'utf8' }).trim();
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const targets = [];
  if (option('tree')) targets.push({ label: option('tree'), base: rev(option('base') ?? 'HEAD'), tree: rev(option('tree')) });
  for (const spec of argv.filter(arg => !arg.startsWith('--'))) {
    const commit = rev(`${spec}^{commit}`);
    targets.push({ label: commit.slice(0, 10), base: rev(`${commit}^`), tree: commit });
  }
  if (!targets.length) {
    console.error('usage: commitPackageTypecheck.mjs --kick | --rolling | --base=<rev> --tree=<tree-ish> | <commit>...');
    return 2;
  }
  // Packets without packages/* sources need no compiler, no worktree and no admission.
  const checked = targets.filter(target => commitTypecheckPackages({ repo, ...target }).packages.length);
  for (const target of targets.filter(target => !checked.includes(target)))
    console.log(`coherent ${target.label}: ${formatCommitPackageTypecheck({ skipped: true }).join('')}`);
  if (!checked.length) return 0;
  const state = commitPackageTypecheckStateDir(repo);
  const worktree = join(state, 'worktree');
  // The worktree lock is taken BEFORE compiler admission and held by this parent for the admitted
  // payload's lifetime, so a queued check never holds a compiler reservation while it waits.
  return await withWorkspaceBundleLock(async () => {
    ensureWorktree(repo, worktree);
    const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_REQUEST: JSON.stringify(checked),
      HAPPIER_COMMIT_TYPECHECK_REPO: repo, HAPPIER_COMMIT_TYPECHECK_LOCKED: '1' };
    const payload = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), '--compiler-admitted'];
    // Fully cached verdicts need no compiler and therefore no admission.
    const command = admittedCommand(repo, payload, checked.every(target => commitPackageTypecheckCached({ repo, ...target })));
    const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 2;
  }, { lockPath: join(state, 'worktree.lock'), timeoutMs: null });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stderr?.toString?.() || error?.message || error);
    process.exitCode = 2;
  }
}
