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
// relative to the parent count (commitTypeCoherenceDiagnostics owns that comparison). `apps/*` and
// `packages/plugins/*` stay on the combined package runs.
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
  const worktree = join(state, 'worktree');
  const cachePath = (treeId, dir) => resultCachePath(state, treeId, dir);
  const readCache = (treeId, dir) => {
    try { return JSON.parse(readFileSync(cachePath(treeId, dir), 'utf8')); } catch { return undefined; }
  };
  const compileEnv = { ...env };
  delete compileEnv.HAPPIER_TYPECHECK_REPORT_DIR;
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete compileEnv[name];
  const locked = async action => env.HAPPIER_COMMIT_TYPECHECK_LOCKED === '1' ? await action()
    : await withWorkspaceBundleLock(action, { lockPath: join(state, 'worktree.lock'), timeoutMs: null });
  return await locked(async () => {
    const lockWaitMs = Date.now() - started;
    ensureWorktree(repo, worktree);
    const results = { base: new Map(), head: new Map() };
    const timings = [];
    for (const side of ['base', 'head']) {
      const treeId = trees[side];
      const missing = [];
      for (const dir of selection.packages) {
        const cached = readCache(treeId, dir);
        if (cached) results[side].set(dir, cached.rows);
        else missing.push(dir);
      }
      if (!missing.length) continue;
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
        execFileSync(process.execPath, [join(worktree, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs'),
          '--validation-kind=typecheck', '--component-relative-dir=', `--repo-dir=${worktree}`, '--execution-placement=local'],
        { cwd: worktree, env: compileEnv, stdio: ['ignore', 'ignore', 'inherit'] });
        timings.push({ side, step: 'dependencies', ms: Date.now() - bootstrapStarted });
      }
      for (const dir of missing) {
        const compiled = compilePackage(worktree, dir, compileEnv);
        timings.push({ side, step: dir, ms: compiled.ms, complete: Boolean(compiled.rows) });
        log(`[commit-package-typecheck] ${side} ${dir} ${(compiled.ms / 1000).toFixed(1)}s ${compiled.rows ? `${compiled.rows.length} diagnostics` : `incomplete ${compiled.failure} ${compiled.tail.join(' | ')}`}`);
        results[side].set(dir, compiled.rows);
        if (!compiled.rows) continue;
        const path = cachePath(treeId, dir);
        mkdirSync(resolve(path, '..'), { recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify({ tree: treeId, package: dir, rows: compiled.rows, ms: compiled.ms }));
        renameSync(`${path}.tmp`, path);
      }
    }
    // Hunks only for files the packet changes; unchanged files keep every position.
    const changedFiles = new Set(nulList(git(['diff', '--name-only', '-z', '--no-renames', trees.base, trees.head])));
    const fresh = [];
    const incomplete = [];
    const unavailable = [];
    for (const dir of selection.packages) {
      const baseRows = results.base.get(dir);
      const headRows = results.head.get(dir);
      // A candidate whose compile does not finish while its parent's does is refused: the
      // candidate is the only change. If neither finishes, the check is unavailable (reported).
      if (!headRows) { (baseRows ? incomplete : unavailable).push(dir); continue; }
      const files = new Set((baseRows ?? []).map(row => row.file).filter(file => changedFiles.has(file)));
      const hunks = new Map([...files].map(file => [file, diagnosticHunks(git(['diff', '--no-ext-diff', '--no-textconv',
        '--no-color', '--no-renames', '--unified=0', trees.base, trees.head, '--', file]))]));
      fresh.push(...newDiagnostics(baseRows ?? [], headRows, hunks).map(row => ({ ...row, package: dir })));
    }
    return { ...selection, skipped: false, trees, fresh, incomplete, unavailable, timings, lockWaitMs, ms: Date.now() - started };
  });
}

const resultCachePath = (state, treeId, dir) => join(state, 'results', treeId, `${dir.replaceAll('/', '__')}.json`);

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

// Owner ruling 2026-11-15: blocking only while a typical commit check stays under ~30 s;
// until then a would-be refusal is printed as WARN and the commit proceeds.
export const COMMIT_PACKAGE_TYPECHECK_BLOCKING = false;

/**
 * The single commit-path entry (commitFromPrivateIndex, checkCommitTypeCoherence, gate.sh through the CLI).
 * Blocking: runs the admitted CLI synchronously; status 1 refuses. Warn-only: never delays the commit;
 * the check runs detached and appends its verdict to `<state>/verdicts.log` (`WARN` = would refuse).
 */
export function runCommitPackageTypecheck({ repo, base, tree, env = process.env }) {
  const childEnv = { ...env };
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete childEnv[name];
  const { packages } = commitTypecheckPackages({ repo, base, tree });
  if (!packages.length) return { status: 0, output: `${formatCommitPackageTypecheck({ skipped: true })[0]}\n` };
  const git = gitAt(repo);
  const args = [fileURLToPath(import.meta.url), `--base=${git(['rev-parse', '--verify', base]).trim()}`, `--tree=${git(['rev-parse', '--verify', tree]).trim()}`];
  if (COMMIT_PACKAGE_TYPECHECK_BLOCKING) {
    const result = spawnSync(process.execPath, args, { cwd: repo, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 2 ** 31 - 1 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout };
  }
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(join(state, 'runs'), { recursive: true });
  const logPath = join(state, 'runs', `${args[2].slice('--tree='.length)}.log`);
  const descriptor = openSync(logPath, 'a');
  try {
    // `--if-idle`: a warn-only check never queues behind another (2026-11-15: queued detached checks
    // piled up behind 5-10 min Protocol checks); a skipped packet is recorded as SKIPPED in verdicts.log.
    spawn(process.execPath, [...args, '--if-idle'], { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', descriptor, descriptor] }).unref();
  } finally {
    closeSync(descriptor);
  }
  return { status: 0, output: `package typecheck (warn-only) started in the background for ${packages.join(', ')}; verdict in ${join(state, 'verdicts.log')} (log ${logPath})\n` };
}

async function main(argv) {
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[name];
  const admitted = argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST;
  if (admitted) {
    const repo = process.env.HAPPIER_COMMIT_TYPECHECK_REPO;
    let refused = 0;
    for (const target of JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST)) {
      const result = await commitPackageTypecheck({ repo, base: target.base, tree: target.tree });
      const refuses = commitPackageTypecheckRefuses(result);
      if (refuses && COMMIT_PACKAGE_TYPECHECK_BLOCKING) refused += 1;
      const verdict = !refuses ? 'coherent' : COMMIT_PACKAGE_TYPECHECK_BLOCKING ? 'INCOHERENT' : 'WARN (would refuse; warn-only)';
      console.log(`${verdict} ${target.label}: ${formatCommitPackageTypecheck(result).join('\n')}`);
      const state = commitPackageTypecheckStateDir(repo);
      mkdirSync(state, { recursive: true });
      appendFileSync(join(state, 'verdicts.log'), `${new Date().toISOString()} ${verdict.split(' ')[0]} base=${target.base} tree=${target.tree} new=${result.fresh.length} incomplete=${result.incomplete.length} ${(result.ms / 1000).toFixed(1)}s ${result.packages.join(',')}${result.fresh.slice(0, 5).map(row => ` | ${row.file}(${row.line}): TS${row.code}`).join('')}\n`);
      console.log(`[commit-package-typecheck-timings] ${JSON.stringify({ label: target.label, lockWaitMs: result.lockWaitMs, ms: result.ms, timings: result.timings })}`);
    }
    return refused ? 1 : 0;
  }
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (argv.includes('--commit-path')) {
    // gate.sh: the same commit-path decision as the JS committers (blocking vs detached warn-only).
    const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    const result = runCommitPackageTypecheck({ repo, base: option('base') ?? 'HEAD', tree: option('tree') });
    process.stdout.write(result.output);
    return result.status ?? 2;
  }
  const rev = spec => execFileSync('git', ['rev-parse', '--verify', spec], { cwd: repo, encoding: 'utf8' }).trim();
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const targets = [];
  if (option('tree')) targets.push({ label: option('tree'), base: rev(option('base') ?? 'HEAD'), tree: rev(option('tree')) });
  for (const spec of argv.filter(arg => !arg.startsWith('--'))) {
    const commit = rev(`${spec}^{commit}`);
    targets.push({ label: commit.slice(0, 10), base: rev(`${commit}^`), tree: commit });
  }
  if (!targets.length) {
    console.error('usage: commitPackageTypecheck.mjs --base=<rev> --tree=<tree-ish> | <commit>...');
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
  // payload's lifetime, so queued committers never hold a compiler reservation while they wait.
  const ifIdle = argv.includes('--if-idle');
  try {
    return await withWorkspaceBundleLock(async () => {
    ensureWorktree(repo, worktree);
    const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_REQUEST: JSON.stringify(checked),
      HAPPIER_COMMIT_TYPECHECK_REPO: repo, HAPPIER_COMMIT_TYPECHECK_LOCKED: '1' };
    const payload = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), '--compiler-admitted'];
    // Fully cached verdicts need no compiler and therefore no admission.
    const cached = checked.every(target => commitPackageTypecheckCached({ repo, ...target }));
    // Native Windows has no shell admission; it runs the payload directly (as the checker does).
    const command = cached || process.platform === 'win32' ? payload : [fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)),
      '--heavyweight-admission', '--class=compilation', `--machine=${process.env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
      // The admitted argv is the admission identity: only stable arguments; the request is in env.
      '--exec-admitted', '--', ...payload];
    const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 2;
    }, { lockPath: join(state, 'worktree.lock'), timeoutMs: null, wait: !ifIdle });
  } catch (error) {
    if (!ifIdle || error?.code !== WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) throw error;
    mkdirSync(state, { recursive: true });
    for (const target of checked) appendFileSync(join(state, 'verdicts.log'), `${new Date().toISOString()} SKIPPED base=${target.base} tree=${target.tree} (another check holds the worktree)\n`);
    return 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stderr?.toString?.() || error?.message || error);
    // Warn-only never blocks a commit on a broken check; blocking fails closed.
    if (!COMMIT_PACKAGE_TYPECHECK_BLOCKING) console.log('WARN package typecheck unavailable (runtime failure above); warn-only, not refusing');
    process.exitCode = COMMIT_PACKAGE_TYPECHECK_BLOCKING ? 2 : 0;
  }
}
