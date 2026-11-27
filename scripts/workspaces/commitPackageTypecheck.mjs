#!/usr/bin/env node
// Commit-time typecheck of the top-level `packages/*` workspaces a packet touches, plus their
// `packages/*` dependents (owner ruling 2026-11-15). It closes the class the textual producer
// closure cannot see: a consumer reading a field, id or type its uncommitted producer adds.
//
//   node scripts/workspaces/commitPackageTypecheck.mjs --base=<rev> --tree=<tree-ish>
//   node scripts/workspaces/commitPackageTypecheck.mjs --scope=apps/ui --tree=<revision>
//   node scripts/workspaces/commitPackageTypecheck.mjs <commit>...     (each against its first parent)
//
// Each package's authored source project (`tsconfig.json`) is compiled by the canonical compiler
// owner (runTypeScriptCli.mjs, with its declaration preparation), followed by the package's own
// declaration emit (TS2883/TS7056 are declaration-emit diagnostics a `--noEmit` check hides), inside
// ONE persistent worktree per host and repository. The worktree keeps the compiler's incremental and declaration state between
// checks and moves its files, index and detached HEAD to each selected tree; its dependencies are installed by
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
// The commit gate (commitGateTypecheck, entry commitGateTypecheck.mjs; P03-GATE-TC 2026-11-18) reuses this owner per
// packet: the packages/* and packages/plugins/* workspaces the packet itself touches (no dependents), its tree against
// its parent, rows from a worker lane of its own (`--lane=gate`) so it never waits behind a rolling app compile.
//
// Exit status: 0 no new diagnostics, nothing to check, or warn-only mode (COMMIT_PACKAGE_TYPECHECK_BLOCKING
// false: would-be refusals print `WARN`); when blocking, 1 for new diagnostics or a candidate compile that
// did not complete while its parent did, 2 for usage or runtime failure (fail closed).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, join, posix, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compilerDiagnosticFromLine } from '../testing/lib/compilerBaseline.mjs';
import { diagnosticHunks, newDiagnostics } from './commitTypeCoherenceDiagnostics.mjs';
import { WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { BOARD_PATH, commitLane } from '../board/postBoardEntry.mjs';
import packageExportMatch from '../../packages/cli-common/packageExportMatch.cjs';
import { packageNameOfSpecifier, resolveWorkspaceSource, workspaceSourcePackageClosure } from '../../packages/cli-common/sourceRuntimeEntries.mjs';
import { readCommitTreeWorkspacePackages } from './commitTreeEntryLoads.mjs';
import { collectPackageBuildOutputTargets } from '../../packages/cli-common/packageBuildOutputTargets.mjs';

const EXACT_DECLARATION_DIRS = new Set(['packages/protocol', 'packages/plugin-sdk']);
const BROAD_REPLAY_PATH = /^(?:(?:apps|packages|scripts)\/.*\.(?:[cm]?[jt]sx?|json)$|pnpm-(?:lock|workspace)\.yaml$|package\.json$|patches\/)/u;
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

function typecheckTreeCommit(git, tree, parent) {
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 'rolling-typecheck', GIT_AUTHOR_EMAIL: 'rolling-typecheck@invalid', GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'rolling-typecheck', GIT_COMMITTER_EMAIL: 'rolling-typecheck@invalid', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z' };
  return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `rolling typecheck tree ${tree}`], { env }).trim();
}

/** One batched object read: `undefined` for an absent spec, otherwise the blob text. */
function readBlobs(repo, specs) {
  if (!specs.length) return [];
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
  return blobs;
}

/** The packages/<name> workspaces whose source typecheck a packet can change, producers first. */
export function commitTypecheckPackages({ repo, base, tree }) {
  const git = gitAt(repo);
  const changed = nulList(git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree]));
  if (!changed.some(path => path.startsWith('packages/'))) return { touched: [], packages: [] };
  const names = nulList(git(['ls-tree', '-z', '--name-only', `${tree}:packages`]));
  const blobs = readBlobs(repo, names.flatMap(name => [`${tree}:packages/${name}/package.json`, `${tree}:packages/${name}/tsconfig.json`]));
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

/** The compile scopes whose own compiler inputs a packet changes, without dependents (the commit gate's selection):
 * packages/<name> and packages/plugins/<name> with a typecheck script and tsconfig.json, and the rolling app scopes. */
export function commitTouchedScopes({ repo, base, tree }) {
  const changed = nulList(gitAt(repo)(['diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree])).filter(path => COMPILER_INPUT.test(path));
  const candidates = new Set();
  for (const path of changed) {
    const app = ROLLING_APP_SCOPES.find(dir => path.startsWith(`${dir}/`));
    const match = /^packages\/(plugins\/[^/]+|[^/]+)\//u.exec(path);
    if (app) candidates.add(app);
    else if (match && match[1] !== 'plugins') candidates.add(`packages/${match[1]}`);
  }
  const dirs = [...candidates].sort();
  const packages = dirs.filter(dir => !isAppScope(dir));
  const blobs = readBlobs(repo, packages.flatMap(dir => [`${tree}:${dir}/package.json`, `${tree}:${dir}/tsconfig.json`]));
  const typed = new Set(packages.filter((dir, index) => {
    const [manifest, config] = [blobs[index * 2], blobs[index * 2 + 1]];
    try { return config !== undefined && Boolean(JSON.parse(manifest).scripts?.typecheck); } catch { return false; }
  }));
  return dirs.filter(dir => isAppScope(dir) || typed.has(dir));
}

/**
 * The commit gate's typecheck plan (P03-GATE-TC 2026-11-18, measured on the commits' own trees): every touched
 * packages/* and packages/plugins/* workspace is checked before the commit lands (blocking); a touched app
 * (apps/server, apps/cli, apps/ui: tens of minutes per compile) is checked by the rolling owner right after it lands.
 */
export function commitGateTypecheckPlan({ repo, base, tree }) {
  const scopes = commitTouchedScopes({ repo, base, tree });
  return { blocking: scopes.filter(dir => !isAppScope(dir)), detached: scopes.filter(isAppScope) };
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

function ensureWorktree(repo, worktree, rev = 'HEAD') {
  if (existsSync(join(worktree, '.git'))) return;
  mkdirSync(resolve(worktree, '..'), { recursive: true });
  const git = gitAt(repo);
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--detach', worktree, rev]);
  // Locked so a `git worktree prune` elsewhere never drops the warm state's registration.
  git(['worktree', 'lock', '--reason', 'commit package typecheck (scripts/workspaces/commitPackageTypecheck.mjs)', worktree]);
}

/** Parses compiler output; `null` when the compiler did not finish with a verdict. */
export function packageTypecheckRows(result, cwd, rootDir) {
  if (result.error || result.signal || ![0, 1, 2].includes(result.status)) return null;
  // The compiler continues after declaration preparation fails. Its diagnostics can be
  // downstream effects of missing inputs and cannot be attributed to this tree.
  if (/^\[typecheck-declaration-failure\] /mu.test(result.stderr)) return null;
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

/** One compiler run through the worktree's canonical compiler owner, its output parsed into rows. */
function runPackageCompiler(worktree, cwd, args, env) {
  const output = mkdtempSync(join(env.TMPDIR || tmpdir(), 'happier-commit-typecheck-'));
  const descriptors = [openSync(join(output, 'stdout'), 'w'), openSync(join(output, 'stderr'), 'w')];
  try {
    // Regular files, not pipes: a compiler descendant can keep a pipe open after the compiler exits.
    const result = spawnSync(process.execPath, [join(worktree, 'scripts/workspaces/runTypeScriptCli.mjs'), ...args, '--pretty', 'false'],
      { cwd, env, stdio: ['ignore', ...descriptors] });
    const stdout = readFileSync(join(output, 'stdout'), 'utf8');
    const stderr = readFileSync(join(output, 'stderr'), 'utf8');
    const rows = packageTypecheckRows({ ...result, stdout, stderr }, cwd, worktree);
    const lines = stderr.split(/\r?\n/u).filter(Boolean);
    const diagnostics = lines.filter(line => line.startsWith('[typecheck-'));
    return { rows, failure: `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}${result.error ? ` error=${result.error.code}` : ''}`,
      tail: diagnostics.length ? diagnostics.slice(-3) : lines.slice(0, 3) };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(output, { recursive: true, force: true });
  }
}

/** The declaration-emit project for a package whose authored project publishes declarations (its build
 * emits them), or null. Type roots stay the package's own: an extending config elsewhere would otherwise
 * look for `types` beside itself (TS2688), as the declaration preparation owner also pins them. */
function declarationProject(cwd, state) {
  const ts = createRequire(join(cwd, 'package.json'))('typescript');
  const configPath = join(cwd, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
  if (parsed?.options.declaration !== true || parsed.options.noEmit === true) return null;
  return { extends: configPath, compilerOptions: {
    noEmit: false, declaration: true, emitDeclarationOnly: true, noCheck: true, declarationMap: false, sourceMap: false,
    incremental: true, outDir: join(state, 'out'), declarationDir: join(state, 'out'), tsBuildInfoFile: join(state, 'tsbuildinfo'),
    typeRoots: ts.getEffectiveTypeRoots(parsed.options, { getCurrentDirectory: () => cwd }),
  } };
}

/**
 * A package's source typecheck plus its declaration emit. `--noEmit` reports declaration diagnostics
 * (TS2883 non-portable inferred type, TS7056 type too large to serialize) only when the program has
 * no other error, so a package carrying any known error never shows them (2026-11-17: TS2883 escaped
 * twice). The second run emits the authored project's declarations with `noCheck`, so it adds only
 * declaration diagnostics, into this host's commit-typecheck state (incremental there), resolving
 * workspace dependencies through the declarations the first run prepared, as the package build does.
 */
function compilePackage(worktree, dir, env) {
  const cwd = join(worktree, dir);
  const started = Date.now();
  const checked = runPackageCompiler(worktree, cwd, ['--noEmit', '-p', 'tsconfig.json'], env);
  const state = join(worktree, '..', 'declarations', dir.replaceAll('/', '__'));
  const config = checked.rows && declarationProject(cwd, state);
  if (!config) return { ...checked, ms: Date.now() - started };
  mkdirSync(state, { recursive: true });
  const project = join(state, 'tsconfig.json');
  writeFileSync(project, JSON.stringify(config));
  const declarationStarted = Date.now();
  const declared = runPackageCompiler(worktree, cwd, ['-p', project], env);
  return { ...(declared.rows ? { rows: [...checked.rows, ...declared.rows] } : declared), ms: Date.now() - started,
    declarationMs: Date.now() - declarationStarted };
}

/** The app's own finite source typecheck (its `typecheck:source:finite` compiler step, without the
 * generated-input checks chained before it), through the canonical compiler owner. */
function compileApp(worktree, dir, env) {
  const cwd = join(worktree, dir);
  // Rolling comparisons read captured source directly and skip lifecycle scripts.
  const preparation = dir === 'apps/ui' ? 'prepareUiBrowserBundles.mjs'
    : dir === 'apps/server' ? 'preparePublicRendererAssets.mjs' : null;
  if (preparation && existsSync(join(cwd, 'scripts', preparation))) {
    const result = spawnSync(process.execPath, [join(cwd, 'scripts', preparation)], { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) return {
      rows: null, ms: 0, failureCode: 'generated-input-preparation',
      failure: `${preparation} exited ${result.status ?? result.signal ?? result.error?.code}: ${result.stderr?.trim().slice(-1200) ?? ''}`,
    };
  }
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const script = String(manifest.scripts?.['typecheck:source:finite'] ?? manifest.scripts?.['typecheck:local'] ?? '');
  const step = script.split('&&').map(part => part.trim()).find(part => /runTypeScriptCli\.mjs/u.test(part));
  if (!step) return { rows: null, ms: 0, failure: 'no runTypeScriptCli step in typecheck:source:finite' };
  const [program, ...args] = step.split(/\s+/u);
  if (program !== 'node') return { rows: null, ms: 0, failure: `unsupported typecheck step ${program}` };
  const output = mkdtempSync(join(env.TMPDIR || tmpdir(), 'happier-commit-typecheck-'));
  const descriptors = [openSync(join(output, 'stdout'), 'w'), openSync(join(output, 'stderr'), 'w')];
  const started = Date.now();
  try {
    // HAPPIER_TYPECHECK_REPORT_DIR makes the compiler owner print plain (--pretty false) diagnostics.
    const reports = join(output, 'reports');
    mkdirSync(reports);
    const result = spawnSync(process.execPath, args, { cwd, env: { ...env, HAPPIER_TYPECHECK_REPORT_DIR: reports }, stdio: ['ignore', ...descriptors] });
    const stdout = readFileSync(join(output, 'stdout'), 'utf8');
    const stderr = readFileSync(join(output, 'stderr'), 'utf8');
    const failureCode = /^\[typecheck-failure\] ([a-z][a-z0-9-]*(?::[A-Za-z0-9_]+)?)(?:\s|$)/mu.exec(stderr)?.[1];
    return { rows: packageTypecheckRows({ ...result, stdout, stderr }, cwd, worktree), ms: Date.now() - started,
      failureCode, failure: `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}${result.error ? ` error=${result.error.code}` : ''}`,
      tail: stderr.split(/\r?\n/u).filter(line => line.startsWith('[typecheck-')).slice(-3) };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(output, { recursive: true, force: true });
  }
}
const compileScope = (worktree, dir, env) => (isAppScope(dir) ? compileApp : compilePackage)(worktree, dir, env);

// Package rows include declaration emit and exclude failed declaration preparation. Older
// cached package rows may contain resulting diagnostics, so they cannot be used for attribution.
const resultCachePath = (state, treeId, dir) => join(state, 'results', treeId, `${dir.replaceAll('/', '__')}${isAppScope(dir) ? '' : '.prepared-declarations'}.json`);

const DEPENDENCY_INPUT = /(?:^|\/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^patches\//u;
const compileEnvOf = env => {
  const compileEnv = { ...env };
  delete compileEnv.HAPPIER_TYPECHECK_REPORT_DIR;
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete compileEnv[name];
  return compileEnv;
};

/** Moves the warm worktree to a tree (the caller holds the worktree lock). */
function moveWorktree({ repo, state, log, worktreeRev }, treeId) {
  const worktree = join(state, 'worktree');
  ensureWorktree(repo, worktree, worktreeRev);
  const currentPath = join(state, 'worktree-tree');
  writeFileSync(currentPath, '');
  // The caller holds the worktree lock, and only its holder runs git in this worktree, so an index.lock
  // here was left by a check killed inside git (2026-11-16: every pass exited 2 for hours after one).
  const git = gitAt(worktree);
  const indexLock = join(git(['rev-parse', '--absolute-git-dir']).trim(), 'index.lock');
  if (existsSync(indexLock)) {
    log(`[commit-package-typecheck] removing ${indexLock} left by an interrupted check`);
    rmSync(indexLock, { force: true });
  }
  git(['read-tree', '--reset', '-u', treeId]);
  // Tooling pins its product dependencies to Git HEAD. A packet may supply a
  // raw tree, so give it a commit in this worker's detached HEAD.
  if (git(['rev-parse', 'HEAD^{tree}']).trim() !== treeId) {
    git(['update-ref', '--no-deref', 'HEAD', typecheckTreeCommit(git, treeId)]);
  }
  writeFileSync(currentPath, treeId);
}

/**
 * The warm worktree's dependencies, installed once per dependency generation (the manifests, lockfile, workspace file
 * and patches of a tree) by the canonical bootstrap owner (the one hstack-exec runs before typecheck payloads). Returns
 * `(treeId) => installed`. The worker runs it as its own step before the compile (P03-GATE-TC 2026-11-18: inside the
 * admitted compile, a cold install made the gate's compile identity record a 15.26 GiB peak for a 1-6 GiB compile).
 * The caller holds the worktree lock.
 */
export function treeDependencyPreparer({ repo, state, env = process.env, log = () => {}, bootstrap, worktreeRev = 'HEAD' }) {
  const git = gitAt(repo);
  const worktree = join(state, 'worktree');
  const install = bootstrap ?? (() => execFileSync(process.execPath, [join(worktree, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs'),
    '--validation-kind=typecheck', '--component-relative-dir=', `--repo-dir=${worktree}`, '--execution-placement=local'],
  { cwd: worktree, env: compileEnvOf(env), stdio: ['ignore', 'ignore', 'inherit'] }));
  const generationPath = join(state, 'dependencies-generation');
  const generation = treeId => createHash('sha256').update(nulList(git(['ls-tree', '-r', '-z', '--full-tree', treeId]))
    .filter(entry => DEPENDENCY_INPUT.test(entry.slice(entry.indexOf('\t') + 1))).join('\0')).digest('hex');
  const prepared = treeId => existsSync(join(worktree, 'node_modules')) && existsSync(generationPath)
    && readFileSync(generationPath, 'utf8').trim() === generation(treeId);
  const prepare = treeId => {
    if (prepared(treeId)) return false;
    moveWorktree({ repo, state, log, worktreeRev }, treeId);
    rmSync(generationPath, { force: true });
    install();
    writeFileSync(generationPath, generation(treeId));
    return true;
  };
  prepare.prepared = prepared;
  return prepare;
}

// TS2688 also covers an authored reference typo. Require a declared npm
// dependency in the selected tree before treating it as an installation failure.
function missingAmbientDeclaration(repo, treeId, dir, rows) {
  const names = rows.flatMap(row => {
    if (row.file !== '<global>' || row.code !== 2688) return [];
    const name = /^Cannot find type definition file for '([^']+)'\./u.exec(row.text)?.[1];
    return name ? [name] : [];
  });
  if (!names.length) return null;
  const git = gitAt(repo);
  const manifests = nulList(git(['ls-tree', '-z', '--name-only', treeId, '--', `${dir}/package.json`, 'package.json']));
  for (const path of manifests) {
    const { dependencies, devDependencies, peerDependencies, optionalDependencies } = JSON.parse(git(['show', `${treeId}:${path}`]));
    const declared = { ...dependencies, ...devDependencies, ...peerDependencies, ...optionalDependencies };
    for (const name of names) {
      const typesName = `@types/${name.replace(/^@/u, '').replace('/', '__')}`;
      if (Object.hasOwn(declared, name) || Object.hasOwn(declared, typesName)) return name;
    }
  }
  return null;
}

const WORKSPACE_OUTPUT_FAILURE = 'missing-workspace-build-output:';
const workspaceOutputFailure = code => typeof code === 'string' && code.startsWith(WORKSPACE_OUTPUT_FAILURE);
const workspaceOutputReason = code => `environment: missing workspace build output (${code.slice(WORKSPACE_OUTPUT_FAILURE.length)})`;

// TS7016 from a published JS export can be judged from its resolved path.
// TS2307 needs the actual compiler worktree to verify the missing output.
function missingPublishedDeclaration(repo, treeId, rows, worktree) {
  let workspaces;
  for (const row of rows) {
    const match = worktree
      ? row.code === 2307 && /^Cannot find module '([^']+)'/u.exec(row.text)
      : row.code === 7016 && /for module '([^']+)'. '([^']+)'/u.exec(row.text);
    if (!match) continue;
    const [, specifier, resolvedJs] = match;
    const name = packageNameOfSpecifier(specifier);
    workspaces ??= readCommitTreeWorkspacePackages(repo, treeId);
    const owner = workspaces.get(name);
    if (!owner) continue;
    const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
    const exported = packageExportMatch.matchPackageExport(owner.manifest.exports, subpath);
    if (!exported) continue;
    const declarationTargets = collectPackageBuildOutputTargets({ exports: exported.declaration })
      .filter(target => target.startsWith('./dist/') && /\.d\.[cm]?ts$/u.test(target))
      .map(target => packageExportMatch.substitutePackageExportTarget(target, exported.replacement).slice(2));
    if (!declarationTargets.length) continue;
    if (worktree) {
      // A composed check can pull source owned by another workspace. That
      // source's manifest determines whether it may use the publication.
      const importer = [...workspaces.values()].reduce((nearest, entry) =>
        row.file.startsWith(`${entry.root}/`) && (!nearest || entry.root.length > nearest.root.length) ? entry : nearest, null);
      if (!importer || !['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .some(field => Object.hasOwn(importer.manifest[field] ?? {}, name))) continue;
      if (declarationTargets.some(target => existsSync(join(worktree, owner.root, target)))) continue;
    } else {
      const resolvedPath = resolvedJs.replaceAll('\\', '/');
      const emittedDeclaration = resolvedPath.replace(/\.([cm]?)js$/u, '.d.$1ts');
      if (!resolvedPath.includes(`/${owner.root}/dist/`)
        || !declarationTargets.some(target => emittedDeclaration.endsWith(`/${owner.root}/${target}`))) continue;
    }
    let source;
    try { source = resolveWorkspaceSource(workspaces, specifier); } catch { continue; }
    const sourcePath = relative(resolve('.'), source).replaceAll('\\', '/');
    if (!/\.[cm]?tsx?$/u.test(sourcePath) || /\.d\.[cm]?ts$/u.test(sourcePath)) continue;
    if (gitAt(repo)(['ls-tree', '--name-only', treeId, '--', sourcePath]).trim() === sourcePath) return specifier;
  }
  return null;
}

/** Rows per (tree, package) from the result cache, compiling the missing ones in the warm worktree, or, with
 * `remote`, taking them from a worker (`remote(treeId, dirs, side)` -> Map of rows or null per package).
 * The caller holds the worktree lock and, when anything compiles here, compiler admission. */
function setTypecheckFailure(rows, dir, code) {
  rows.failures ??= new Map();
  rows.failures.set(dir, code);
}

export function treeTypechecker({ repo, state, env, log, compile = compileScope, bootstrap, remote = null, worktreeRev = 'HEAD', capturedWorktree }) {
  const worktree = capturedWorktree ?? join(state, 'worktree');
  const compileEnv = compileEnvOf(env);
  const prepareDependencies = treeDependencyPreparer({ repo, state, env, log, bootstrap, worktreeRev });
  const timings = [];
  const judgeRows = (treeId, rows, side, dir) => {
    if (!rows) return rows;
    const ambient = missingAmbientDeclaration(repo, treeId, dir, rows);
    const workspace = ambient ? null : missingPublishedDeclaration(repo, treeId, rows);
    if (!ambient && !workspace) return rows;
    const reason = ambient ? `missing-ambient-declaration: ${ambient}` : `missing-workspace-declaration: ${workspace}`;
    log(`[commit-package-typecheck] ${side} ${dir} incomplete ${reason}`);
    return null;
  };
  const readCachedRows = (treeId, dir, side) => {
    try {
      const { rows } = JSON.parse(readFileSync(resultCachePath(state, treeId, dir), 'utf8'));
      return judgeRows(treeId, rows, side, dir);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return null;
    }
  };
  const rowsAndMissing = (treeId, packages, side) => {
    const rows = new Map();
    const missing = [];
    const manifests = readBlobs(repo, packages.map(dir => `${treeId}:${dir}/package.json`));
    for (const [index, dir] of packages.entries()) {
      // A package introduced by the candidate has an empty parent baseline.
      const cached = manifests[index] === undefined ? [] : readCachedRows(treeId, dir, side);
      if (cached) rows.set(dir, cached);
      else missing.push(dir);
    }
    return { treeId, side, rows, missing };
  };
  const rowsAt = (treeId, packages, side = treeId.slice(0, 10)) => {
    const { rows, missing } = rowsAndMissing(treeId, packages, side);
    if (!missing.length) return rows;
    const store = (dir, compiled) => {
      const path = resultCachePath(state, treeId, dir);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({ tree: treeId, package: dir, rows: compiled.rows, ms: compiled.ms }));
      renameSync(`${path}.tmp`, path);
    };
    if (remote) return (async () => {
      const started = Date.now();
      const fetched = await remote(treeId, missing, side);
      const ms = Date.now() - started;
      timings.push({ side, step: 'worker', ms });
      for (const dir of missing) {
        // undefined: no worker judged the tree (unreachable, no rows); null: its compile did not complete.
        const workerRows = judgeRows(treeId, fetched?.get(dir), side, dir);
        log(`[commit-package-typecheck] ${side} ${dir} worker ${(ms / 1000).toFixed(1)}s ${workerRows ? `${workerRows.length} diagnostics` : 'incomplete'}`);
        rows.set(dir, workerRows);
        if (workerRows) store(dir, { rows: workerRows, ms });
        else setTypecheckFailure(rows, dir, fetched?.failures?.get(dir)
          ?? (fetched?.get(dir) === undefined ? 'worker-unavailable' : 'worker-compile-incomplete'));
      }
      return rows;
    })();
    // Dependencies first (a no-op when the worker's preparation step already installed this generation).
    if (!capturedWorktree) {
      const bootstrapStarted = Date.now();
      if (prepareDependencies(treeId)) timings.push({ side, step: 'dependencies', ms: Date.now() - bootstrapStarted });
      const moveStarted = Date.now();
      moveWorktree({ repo, state, log, worktreeRev }, treeId);
      timings.push({ side, step: 'move', ms: Date.now() - moveStarted });
    }
    // Exact-tree worktrees bypass command-replica preparation. Refresh this
    // ignored source input from the selected tree before declaration analysis
    // imports Protocol, including policy-only moves with unchanged dependencies.
    const policyGenerator = join(worktree, 'packages/protocol/scripts/generate-embedded-feature-policies.mjs');
    if (existsSync(policyGenerator)) {
      try {
        execFileSync(process.execPath, [policyGenerator], {
          cwd: worktree, env: compileEnv, stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        log(`[commit-package-typecheck] ${side} incomplete generated-input-preparation: ${error.message}`);
        for (const dir of missing) {
          rows.set(dir, null);
          setTypecheckFailure(rows, dir, 'generated-input-preparation');
        }
        return rows;
      }
    }
    for (const dir of missing) {
      const compiled = compile(worktree, dir, compileEnv);
      const missingOutput = compiled.rows && missingPublishedDeclaration(repo, treeId, compiled.rows, worktree);
      if (missingOutput) {
        compiled.rows = null;
        compiled.failureCode = WORKSPACE_OUTPUT_FAILURE + missingOutput;
        compiled.failure = workspaceOutputReason(compiled.failureCode);
      }
      timings.push({ side, step: dir, ms: compiled.ms, complete: Boolean(compiled.rows) });
      log(`[commit-package-typecheck] ${side} ${dir} ${(compiled.ms / 1000).toFixed(1)}s${compiled.declarationMs === undefined ? '' : ` (declaration emit ${(compiled.declarationMs / 1000).toFixed(1)}s)`} ${compiled.rows ? `${compiled.rows.length} diagnostics` : `incomplete ${compiled.failure} ${compiled.tail?.join(' | ') ?? ''}`}`);
      const judged = judgeRows(treeId, compiled.rows, side, dir);
      rows.set(dir, judged);
      if (judged) store(dir, compiled);
      else setTypecheckFailure(rows, dir, compiled.failureCode ?? (compiled.rows ? 'compiler-input-incomplete' : 'compiler-incomplete'));
    }
    return rows;
  };
  /** Rows for several trees. They share the worker dispatch while each tree has its own compile admission. */
  const rowsAtMany = async (requests, { cachedOnly = false } = {}) => {
    if (!remote && !cachedOnly) return requests.map(({ treeId, packages, side }) => rowsAt(treeId, packages, side));
    const cached = requests.map(({ treeId, packages, side }) => rowsAndMissing(treeId, packages, side));
    const pending = cached.filter(entry => entry.missing.length);
    if (pending.length && !cachedOnly) {
      const started = Date.now();
      const dirs = [...new Set(pending.flatMap(entry => entry.missing))];
      const fetched = await remote(pending.map(entry => entry.treeId), dirs, pending.map(entry => entry.side));
      const ms = Date.now() - started;
      timings.push({ side: pending.map(entry => entry.side).join('+'), step: 'worker', ms });
      for (const entry of pending) {
        for (const dir of entry.missing) {
          const workerRows = judgeRows(entry.treeId, fetched?.get(entry.treeId)?.get(dir), entry.side, dir);
          log(`[commit-package-typecheck] ${entry.side} ${dir} worker ${(ms / 1000).toFixed(1)}s ${workerRows ? `${workerRows.length} diagnostics` : 'incomplete'}`);
          entry.rows.set(dir, workerRows);
          if (workerRows) {
            const path = resultCachePath(state, entry.treeId, dir);
            mkdirSync(resolve(path, '..'), { recursive: true });
            const temporary = `${path}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify({ tree: entry.treeId, package: dir, rows: workerRows, ms }));
            renameSync(temporary, path);
          } else setTypecheckFailure(entry.rows, dir, fetched?.get(entry.treeId)?.failures?.get(dir)
            ?? (workerRows === undefined ? 'worker-unavailable' : 'worker-compile-incomplete'));
        }
      }
    }
    return cached.map(entry => entry.rows);
  };
  return { rowsAt, rowsAtMany, timings };
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
 * candidate adds, or all diagnostics for a named app scope. The caller must already
 * hold compiler admission for local rows (the CLI acquires it).
 */
export async function commitPackageTypecheck({ repo, base, tree, env = process.env, log = message => process.stderr.write(`${message}\n`),
  packages, remote = null, cachedOnly = false, scope }) {
  const started = Date.now();
  const git = gitAt(repo);
  if (scope && !isAppScope(scope)) throw new Error(`Unknown app typecheck scope: ${scope}`);
  const selection = scope ? { touched: [scope], packages: [scope] }
    : packages ? { touched: packages, packages } : commitTypecheckPackages({ repo, base, tree });
  if (!selection.packages.length) return { ...selection, skipped: true, fresh: [], incomplete: [], unavailable: [], timings: [], ms: Date.now() - started };
  const trees = { base: scope ? null : git(['rev-parse', `${base}^{tree}`]).trim(), head: git(['rev-parse', `${tree}^{tree}`]).trim() };
  const state = commitPackageTypecheckStateDir(repo, env);
  // Rows from a worker never touch this host's warm worktree, so they need no lock on it.
  const locked = async action => remote || env.HAPPIER_COMMIT_TYPECHECK_LOCKED === '1' ? await action()
    : await withWorkspaceBundleLock(action, { lockPath: join(state, 'worktree.lock'), timeoutMs: null });
  return await locked(async () => {
    const lockWaitMs = Date.now() - started;
    const { rowsAtMany, timings } = treeTypechecker({ repo, state, env, log, remote });
    // A named app replay judges its selected tree even with no package diff.
    // The existing locked worktree owns preparation through compiler exit.
    if (scope) {
      const [rows] = await rowsAtMany([{ treeId: trees.head, packages: [scope], side: 'replay' }], { cachedOnly });
      const diagnostics = rows.get(scope);
      return { ...selection, skipped: false, trees, fresh: diagnostics ?? [],
        incomplete: diagnostics === null ? [scope] : [], unavailable: diagnostics === undefined ? [scope] : [],
        environment: [...(rows.failures ?? [])].map(([dir, code]) => `${dir}: ${code}`),
        timings, lockWaitMs, ms: Date.now() - started };
    }
    const [baseRows, headRows] = await rowsAtMany([{ treeId: trees.base, packages: selection.packages, side: 'base' },
      { treeId: trees.head, packages: selection.packages, side: 'head' }], { cachedOnly });
    const compared = freshBetween(git, trees.base, trees.head, selection.packages, baseRows, headRows);
    const fresh = compared.fresh.map(({ dir, row }) => ({ ...row, package: dir }));
    // A candidate no worker judged (unreachable, no rows) is not the candidate's doing: unavailable, never refused.
    const environment = [baseRows, headRows].flatMap(rows =>
      [...(rows.failures ?? [])].filter(([, code]) => workspaceOutputFailure(code)).map(([, code]) => workspaceOutputReason(code)));
    const unjudged = compared.incomplete.filter(dir => headRows.get(dir) === undefined
      || workspaceOutputFailure(headRows.failures?.get(dir)));
    return { ...selection, skipped: false, trees, fresh, incomplete: compared.incomplete.filter(dir => !unjudged.includes(dir)),
      unavailable: [...compared.unavailable, ...unjudged], environment: [...new Set(environment)],
      timings, lockWaitMs, ms: Date.now() - started };
  });
}


/** True when both trees' results for every selected package are cached (no compiler needed). */
export function commitPackageTypecheckCached({ repo, base, tree, env = process.env }) {
  const git = gitAt(repo);
  const state = commitPackageTypecheckStateDir(repo, env);
  const { packages } = commitTypecheckPackages({ repo, base, tree });
  return [base, tree].every(rev => {
    const treeId = git(['rev-parse', `${rev}^{tree}`]).trim();
    const manifests = readBlobs(repo, packages.map(dir => `${treeId}:${dir}/package.json`));
    return packages.every((dir, index) => manifests[index] === undefined || existsSync(resultCachePath(state, treeId, dir)));
  });
}

/** Human-readable verdict lines; also what committers see when a packet is refused. */
export function formatCommitPackageTypecheck(result) {
  if (result.supersededBy) return [`package typecheck: superseded by rolling ${result.supersededBy.slice(0, 11)} (${result.packages.join(', ')})`];
  if (result.skipped) return ['package typecheck: skipped (no packages/* source touched)'];
  const lines = [`package typecheck: ${result.packages.join(', ')} new=${result.fresh.length} incomplete=${result.incomplete.length} unavailable=${result.unavailable.length} ${(result.ms / 1000).toFixed(1)}s`];
  for (const row of result.fresh) lines.push(`  ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text}`);
  for (const dir of result.incomplete) lines.push(`  ${dir}: the candidate's typecheck did not complete (its parent's did)`);
  for (const dir of result.unavailable) lines.push(`  ${dir}: typecheck comparison unavailable`);
  for (const reason of result.environment ?? []) lines.push(`  ${reason}`);
  return lines;
}

export const commitPackageTypecheckRefuses = result => !result.skipped && (result.fresh.length > 0 || result.incomplete.length > 0);

/** The commit gate's worker lane: its own warm worktree beside the rolling one (sharing its bare repository), so a gate
 * never waits behind a rolling app compile (up to hours) for the worktree, and its own admission identity. */
const GATE_LANE = 'gate';
export const COMMIT_GATE_TYPECHECK_ENTRY = 'scripts/workspaces/commitGateTypecheck.mjs';
const GATE_PACKAGE_CHECK_CLASS = 'gate-package-typecheck';
const GATE_DECLARATION_COMPARISON_CLASS = 'gate-declaration-comparison';

/**
 * The commit gate's blocking typecheck (gate.sh and commitFromPrivateIndex.mjs call this one function): the delta of
 * every packages/* and packages/plugins/* workspace the packet touches, its own tree against its parent's, rows from
 * the gate's worker lane. Only diagnostics new against the parent count (freshBetween). A worker that cannot judge
 * leaves the scope `unavailable`, which never refuses: the rolling HEAD typecheck still covers it. Touched apps are
 * returned as `detached`; the rolling owner checks them once the commit lands (kickRollingHeadTypecheck).
 * A cached-only comparison uses existing rows and returns unavailable for any missing side.
 */
export async function commitGateTypecheck({ repo, base, tree, env = process.env, log = message => process.stderr.write(`${message}\n`), remote, record = true, packages, workers, cachedOnly = false, requireInherited = false }) {
  const plan = packages ? { blocking: packages, detached: [] } : commitGateTypecheckPlan({ repo, base, tree });
  const state = commitPackageTypecheckStateDir(repo, env);
  const worker = workerTreeRows({ repo, state, env, log, lane: GATE_LANE, entry: COMMIT_GATE_TYPECHECK_ENTRY, workers });
  const controller = packages && !workers && existsSync(join(repo, 'node_modules', 'typescript'))
    ? controllerDeclarationRows({ repo, env, log, requireInherited }) : null;
  const compare = remote ?? (controller ? async (trees, dirs, sides) => {
    const rows = await controller(trees, dirs, sides);
    if (requireInherited || rows.cancelled || trees.every(tree => dirs.every(dir => Array.isArray(rows.get(tree)?.get(dir))))) return rows;
    log('[commit-package-typecheck] controller comparison incomplete; trying exact-tree workers');
    return await worker(trees, dirs, sides);
  } : requireInherited ? async () => new Map() : worker);
  const result = await commitPackageTypecheck({ repo, base, tree, env, log, packages: plan.blocking, cachedOnly, remote: compare });
  if (!result.skipped && record && !cachedOnly) {
    mkdirSync(state, { recursive: true });
    const verdict = commitPackageTypecheckRefuses(result) ? 'REFUSED' : result.environment.length ? 'environment' : 'ok';
    const reason = result.environment.length ? ` reason=${result.environment.join(', ')}` : '';
    appendFileSync(join(state, 'verdicts.log'), `${new Date().toISOString()} GATE-${verdict} base=${result.trees.base} tree=${result.trees.head} packages=${result.packages.join(',')} new=${result.fresh.length} incomplete=${result.incomplete.join(',') || '-'} unavailable=${result.unavailable.join(',') || '-'} ${(result.ms / 1000).toFixed(1)}s${reason}\n`);
  }
  return { ...result, detached: plan.detached };
}

/** A green range can still list packages that the worker could not compare. */
function coveringRollingHead(repo, verdictPath, commit, packages) {
  let verdicts;
  try { verdicts = readFileSync(verdictPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  for (const line of verdicts.split('\n').reverse()) {
    const row = /^\S+ ROLLING-ok scope=packages base=\S+ head=([0-9a-f]+) packages=(\S+) new=0(?: incomplete=(\S+) unavailable=(\S+))? /u.exec(line);
    if (!row) continue;
    const [, head, selected, incomplete, unavailable] = row;
    const checked = new Set(selected.split(','));
    for (const dir of `${incomplete},${unavailable}`.split(',')) checked.delete(dir);
    if (!packages.every(dir => checked.has(dir))) continue;
    if (spawnSync('git', ['merge-base', '--is-ancestor', commit, head], { cwd: repo, env: gitEnv() }).status === 0) return head;
  }
}

function cutAfterCommit(repo, sha) {
  let board;
  try { board = readFileSync(join(repo, BOARD_PATH), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutRef = /^### [^\n]+ — Systemic → [^\n]+ — RULING — cut \d+ is NAMED: ([a-f0-9]{7,40})\b/mu.exec(board)?.[1];
  if (!cutRef) return;
  const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${cutRef}^{commit}`], {
    cwd: repo, env: gitEnv(), encoding: 'utf8',
  });
  if (resolved.error) throw resolved.error;
  const cut = resolved.stdout.trim();
  const isAncestor = (base, head) =>
    spawnSync('git', ['merge-base', '--is-ancestor', base, head], { cwd: repo, env: gitEnv() }).status === 0;
  if (cut && sha !== cut && isAncestor(sha, cut) && isAncestor(cut, 'HEAD')) return cut;
}

/** On the shared branch, a backlogged packet needs a current-cut or later package verdict to alert. */
function diagnosticsStillAtHead({ repo, state, sha, fresh, verdictPath }) {
  const cut = cutAfterCommit(repo, sha);
  if (!cut) return fresh;
  // Both rolling and per-commit workers publish exact-tree verdicts to this
  // cache. Plugins are checked by the latter and are outside the rolling scope.
  const git = gitAt(repo);
  const candidates = git(['log', '--first-parent', '--format=%H %T', `${cut}^..HEAD`]).trim().split('\n');
  const key = ({ file, line, code }) => `${file}:${line}:TS${code}`;
  const checked = new Map([...new Set(fresh.map(row => row.package))].map(dir => [dir, undefined]));
  for (const candidate of candidates) {
    const [head, tree] = candidate.split(' ');
    for (const [dir, verdict] of checked) {
      if (verdict) continue;
      try {
        const cached = JSON.parse(readFileSync(resultCachePath(state, tree, dir), 'utf8'));
        if (cached.tree === tree && cached.package === dir && Array.isArray(cached.rows)) {
          checked.set(dir, { head, locations: new Set(cached.rows.map(key)) });
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    if ([...checked.values()].every(Boolean)) break;
  }

  return fresh.filter(row => {
    const verdict = checked.get(row.package);
    if (verdict?.locations.has(key(row))) return true;
    const status = verdict ? `fixed by HEAD ${verdict.head}` : `HEAD unverified at or after cut ${cut}`;
    appendFileSync(verdictPath, `${new Date().toISOString()} GATE-REPORT-HEAD introduced at ${sha}, ${status} ${row.package} ${key(row)}\n`);
    return false;
  });
}

function recordGateReport(path, sha, result, verdict) {
  const reason = result.environment?.length ? ` reason=${result.environment.join(', ')}` : '';
  appendFileSync(path, `${new Date().toISOString()} GATE-REPORT-${verdict} commit=${sha} packages=${result.packages.join(',')} new=${result.fresh.length} incomplete=${result.incomplete.join(',') || '-'} unavailable=${result.unavailable.join(',') || '-'} wall=${(result.ms / 1000).toFixed(1)}s${result.supersededBy ? ` rolling=${result.supersededBy}` : ''}${reason}\n`);
}

/**
 * Report-and-URGENT mode of the gate check (P03 ORCH 2026-11-18, before it blocks): a landed commit's touched
 * packages/* and packages/plugins/* workspaces against its parent; new errors go to the commit's author lane as one board URGENT. `GATE-REPORT-*` lines in verdicts.log carry the check's wall time, the gate wait it would add
 * at most, which decides when it blocks. Returns null when the commit touches none of those workspaces.
 */
export async function reportCommitGateTypecheck({ repo, commit, env = process.env, log = message => process.stderr.write(`${message}\n`), remote, workers,
  post = entry => postBoardEntry(repo, entry) }) {
  const git = gitAt(repo);
  const sha = git(['rev-parse', `${commit}^{commit}`]).trim();
  const base = git(['rev-parse', `${sha}^`]).trim();
  const { blocking: packages, detached } = commitGateTypecheckPlan({ repo, base, tree: sha });
  if (!packages.length) return null;
  const started = Date.now();
  const state = commitPackageTypecheckStateDir(repo, env);
  const verdictPath = join(state, 'verdicts.log');
  mkdirSync(state, { recursive: true });
  // A range verdict cannot substitute for the exact declaration comparison of each Protocol or SDK commit.
  const supersededBy = packages.some(dir => EXACT_DECLARATION_DIRS.has(dir))
    ? undefined : coveringRollingHead(repo, verdictPath, sha, packages);
  if (supersededBy) {
    const result = { touched: packages, packages, detached, skipped: true, fresh: [], incomplete: [], unavailable: [],
      timings: [], ms: Date.now() - started, supersededBy };
    recordGateReport(verdictPath, sha, result, 'superseded');
    return result;
  }
  const result = await commitGateTypecheck({ repo, base, tree: sha, env, log, remote, workers, record: false });
  const rows = result.fresh.length ? diagnosticsStillAtHead({ repo, state, sha, fresh: result.fresh, verdictPath }) : [];
  if (rows.length) {
    const [subject, author] = git(['log', '-1', '--format=%s%n%an', sha]).trim().split('\n');
    try { post(urgentEntry({ commit: sha, subject, author, lane: commitLane(git, sha), check: EXACT_DECLARATION_DIRS.has(rows[0].package) ? 'Declaration comparison' : 'Package typecheck', rows, base, head: sha, how: 'the commit gate typecheck (report mode) finds' })); }
    catch (error) { log(`[commit-gate-typecheck] board post failed for ${sha.slice(0, 11)}: ${error?.message ?? error}`); }
  }
  const verdict = result.fresh.length ? 'RED' : result.environment?.length ? 'environment'
    : result.incomplete.length || result.unavailable.length ? 'incomplete' : 'ok';
  recordGateReport(verdictPath, sha, result, verdict);
  return result;
}

function hasBroadCommitReplay(repo, commit) {
  return gitAt(repo)(['diff', '--no-renames', '--name-only', '-z', `${commit}^`, commit])
    .split('\0').some(path => BROAD_REPLAY_PATH.test(path));
}

function broadFailureAtHead({ git, verdictPath, cut, failure }) {
  const reports = new Map();
  const lines = readFileSync(verdictPath, 'utf8').split('\n');
  lines.pop(); // Another drainer may be appending the last record.
  for (const line of lines) {
    const row = /^\S+ BROAD-REPORT-(?:ok|RED|incomplete) commit=([0-9a-f]+) exit=\S+(?: checks=(.*))?$/u.exec(line);
    if (row) reports.set(row[1], row[2]);
  }
  // The queue can finish old commits after newer ones. Choose by branch order.
  const head = git(['log', '--first-parent', '--format=%H', `${cut}^..HEAD`]).trim().split('\n')
    .find(sha => reports.has(sha));
  const checks = reports.get(head);
  // A replay may skip this graph, stop at an earlier phase, or predate per-check evidence.
  const keys = checks && failure && JSON.parse(checks).find(([check]) => check === failure.check)?.[1];
  return { head, present: keys ? keys.includes(failure.key ?? 'failed') : undefined };
}

async function reportBroadCommitReplay({ repo, commit, env, post = entry => postBoardEntry(repo, entry),
  log = message => process.stderr.write(`${message}\n`) }) {
  const script = join(repo, 'scripts/workspaces/runCommitPostChecks.sh');
  if (!existsSync(script) || !hasBroadCommitReplay(repo, commit) || process.platform === 'win32') return;
  const git = gitAt(repo);
  const base = git(['rev-parse', `${commit}^`]).trim();
  // The existing report consumer runs each exact replay outside the commit lock.
  // Its entry and bundle phases acquire and release their own grants in sequence.
  const child = spawn('bash', [script, base, commit], { cwd: repo, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let failure;
  const checks = new Map();
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', line => {
    const failed = /^HAPPIER_POST_COMMIT_FAILURE\t([^\t]+)\t([^\t]*)(?:\t(.*))?$/u.exec(line);
    if (failed) {
      const [, check, path, key] = failed;
      failure ??= { check, path, key };
      if (!checks.has(check)) checks.set(check, [key ?? 'failed']);
      return;
    }
    const checked = /^HAPPIER_POST_COMMIT_CHECK\t([^\t]+)(?:\t(.*))?$/u.exec(line);
    if (checked) {
      const [, check, key] = checked;
      if (!checks.has(check)) checks.set(check, []);
      if (key !== undefined) checks.get(check).push(key);
      return;
    }
    process.stdout.write(line + '\n');
  });
  const [status] = await once(child, 'close').catch(error => {
    log(`[commit-checks] broad replay could not start for ${commit}: ${error.message}`);
    return [75];
  });
  const verdict = status === 0 ? 'ok' : status === 10 ? 'RED' : 'incomplete';
  const verdictPath = join(commitPackageTypecheckStateDir(repo, env), 'verdicts.log');
  appendFileSync(verdictPath, `${new Date().toISOString()} BROAD-REPORT-${verdict} commit=${commit} exit=${status} checks=${JSON.stringify([...checks])}\n`);
  if (status !== 10) return;
  const cut = cutAfterCommit(repo, commit);
  let checkedHead;
  if (cut) {
    const { head, present } = broadFailureAtHead({ git, verdictPath, cut, failure });
    if (!present) {
      const status = present === false ? `fixed by HEAD ${head}` : `HEAD unverified at or after cut ${cut}`;
      appendFileSync(verdictPath, `${new Date().toISOString()} BROAD-REPORT-HEAD introduced at ${commit}, ${status} ${failure?.check ?? 'Broad post-commit replay'} ${failure?.path ?? ''}\n`);
      return;
    }
    checkedHead = head;
  }
  const lane = commitLane(git, commit);
  const author = git(['log', '-1', '--format=%an', commit]).trim();
  const addressees = lane ?? 'P03 ORCH';
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const entry = [
    `### ${stamp} UTC — P03-COMMIT-CHECKS → ${addressees} — URGENT — Broad post-commit checks failed for ${commit.slice(0, 11)}`,
    `- ${lane ? `${lane}: fix forward` : `P03 ORCH: route to author ${author} for a fix forward`}. The exact commit ${commit} adds an entry, bundle or export failure over its parent ${base}.`,
    `- ${failure?.check ?? 'Broad post-commit replay'} failed at ${failure?.path ? inlineCode(failure.path) : 'an unreported path'}. Details in \`runs/gate-report.log\`.`,
    ...(checkedHead ? [`- This failure is also present in the broad report for checked HEAD ${checkedHead}.`] : []),
    '',
  ].join('\n');
  try { post(entry); }
  catch (error) { log(`[commit-checks] broad report board post failed for ${commit}: ${error.message}`); }
}

const gateReportQueuePath = state => join(state, 'gate-report-queue');

/** Queues a landed commit for report mode; the single drainer (`drainCommitGateReports`) checks it. */
export function queueCommitGateReport({ repo, env = process.env, commit }) {
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(state, { recursive: true });
  appendFileSync(gateReportQueuePath(state), `${commit}\n`);
}

/** Takes the oldest queued commit, or undefined (the claim lock is held only for the read and rewrite). */
async function takeQueuedCommit(state) {
  const queue = gateReportQueuePath(state);
  return await withWorkspaceBundleLock(async () => {
    if (!existsSync(queue)) return undefined;
    const [first, ...rest] = [...new Set(readFileSync(queue, 'utf8').split('\n').filter(Boolean))];
    if (rest.length) {
      writeFileSync(`${queue}.${process.pid}`, `${rest.join('\n')}\n`);
      renameSync(`${queue}.${process.pid}`, queue);
    } else rmSync(queue, { force: true });
    return first;
  }, { lockPath: `${queue}.lock`, timeoutMs: null });
}

/**
 * One report-mode consumer: takes queued commits one at a time, oldest first, and checks each on `worker`. One consumer per worker and
 * host (its lock, without waiting; a second one returns []), so two consumers split one queue: a serial lane handles
 * ~30 commits/h and ~50 package commits/h arrived at 21:00Z on 2026-11-18. The holder re-reads the queue before it
 * lets go (2026-11-18 21:00-21:12Z: one detached process per commit, 10 in 12 min, piled up behind the gate lane).
 */
export async function drainCommitGateReports({ repo, env = process.env, worker, workerCandidates, ...options }) {
  const eligible = workerCandidates ? filterExecutionWorkers(workerCandidates, env) : [...typecheckWorkerConnections(repo, env, GATE_PACKAGE_CHECK_CLASS).keys()];
  worker ??= eligible[0];
  if (!eligible.includes(worker)) return [];
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(state, { recursive: true });
  const queue = gateReportQueuePath(state);
  const workers = [worker];
  const drained = [];
  for (;;) try {
    await withWorkspaceBundleLock(async () => {
      for (let commit; (commit = await takeQueuedCommit(state));) {
        await reportCommitGateTypecheck({ repo, env, commit, workers, ...options });
        try {
          await reportBroadCommitReplay({ repo, commit, env, ...options });
        } catch (error) {
          (options.log ?? console.error)(`[commit-checks] broad report unavailable for ${commit}: ${error.message}`);
        }
        drained.push(commit);
      }
    }, { lockPath: join(state, `gate-report-${worker}.lock`), timeoutMs: null, wait: false });
    // A commit queued between the holder's last read and its release: its own kick found this consumer busy.
    if (!existsSync(queue)) return drained;
  } catch (error) {
    if (error?.code !== WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) throw error;
    return drained;
  }
}

const ROLLING_HEAD = 'rolling-head';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const inlineCode = value => `\`${value.replaceAll('`', '\\`')}\``;

function urgentEntry({ commit, subject, author, lane, check = 'Rolling typecheck', rows, base, head, how }) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const addressees = lane ?? 'P03 ORCH';
  return [
    `### ${stamp} UTC — P03-COMMIT-CHECKS → ${addressees} — URGENT — new type errors from ${commit.slice(0, 11)}`,
    `- ${lane ? `${lane}: fix forward` : `P03 ORCH: route to ${author ?? 'the author'} for a fix forward`}: ${how ? `${how} ${rows.length} new error(s) in \`${commit.slice(0, 11)}\` ("${subject}") against its parent ${base.slice(0, 11)}.`
      : `the rolling HEAD typecheck attributes ${rows.length} new error(s) to \`${commit.slice(0, 11)}\` ("${subject}") by bisecting ${base.slice(0, 11)}..${head.slice(0, 11)}.`}`,
    `- ${check} failed at ${rows[0].file === '<global>' ? 'an unreported path' : inlineCode(rows[0].file)}.`,
    ...rows.slice(0, 8).map(row => `  - ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text.replace(/\s+/gu, ' ').slice(0, 200)}`),
    ...(rows.length > 8 ? [`  - … ${rows.length - 8} more: \`node scripts/workspaces/commitPackageTypecheck.mjs ${commit.slice(0, 11)}\``] : []),
    '',
  ].join('\n');
}

function postBoardEntry(repo, entry) {
  const temp = mkdtempSync(join(tmpdir(), 'happier-rolling-typecheck-post-'));
  try {
    writeFileSync(join(temp, 'entry.md'), entry);
    execFileSync(process.execPath, [join(repo, 'scripts/board/postBoardEntry.mjs'), join(repo, BOARD_PATH), join(temp, 'entry.md')], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Each scope records its own last checked HEAD; the packages scope keeps its original file. */
const rollingHeadPath = (state, scope) => join(state, scope === 'packages' ? ROLLING_HEAD : `${ROLLING_HEAD}-${scope.replaceAll('/', '__')}`);
// Without a recorded baseline the whole scope compiles: a range-filtered first pass could record
// an unchecked skip as the baseline (2026-11-17 08:33Z, apps/server).
const rollingScopeDirs = ({ repo, base, head, scope, baseline = false }) => {
  const from = baseline ? EMPTY_TREE : base;
  return scope === 'packages'
    ? commitTypecheckPackages({ repo, base: from, tree: head }).packages
    : commitTypecheckApps({ repo, base: from, tree: head }).filter(dir => dir === scope);
};

/** The last checked HEAD; without a usable one (first run, rewritten history) the newest commit's parent. */
function rollingBase(repo, recorded, head) {
  const ancestor = recorded && spawnSync('git', ['merge-base', '--is-ancestor', recorded, head], { cwd: repo, env: gitEnv() }).status === 0;
  return ancestor ? recorded : gitAt(repo)(['rev-parse', `${head}^`]).trim();
}

/** Older app passes could store a checkpoint even when neither tree was judged. */
function isUnjudgedAppCheckpoint(state, scope, commit) {
  if (!commit || !isAppScope(scope)) return false;
  let verdicts;
  try { verdicts = readFileSync(join(state, 'verdicts.log'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const match = verdicts.split('\n').findLast(line =>
    line.includes(` scope=${scope} `) && line.includes(` head=${commit} `) && !line.includes(' ROLLING-ATTRIBUTED '));
  return !match?.includes(' headTree=') && / (?:incomplete|unavailable)=apps\/(?:server|cli|ui)(?:[, ]|$)/u.test(match ?? '');
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
  compile, bootstrap, remote, post = entry => postBoardEntry(repo, entry), scope = 'packages',
  attribute = true, pending = null }) {
  const started = Date.now();
  const git = gitAt(repo);
  const state = commitPackageTypecheckStateDir(repo, env);
  mkdirSync(state, { recursive: true });
  const head = pending?.head ?? git(['rev-parse', 'HEAD']).trim();
  const recordedPath = rollingHeadPath(state, scope);
  const recorded = pending ? pending.base : existsSync(recordedPath) ? readFileSync(recordedPath, 'utf8').trim() : '';
  const result = { scope, base: recorded, head, attributions: [], incomplete: [], unavailable: [], packages: [], failures: [] };
  const invalidatedBaseline = !pending && isUnjudgedAppCheckpoint(state, scope, recorded) ? recorded : '';
  const needsBaseline = !recorded || !!invalidatedBaseline;
  if (recorded === head && !needsBaseline) return result;
  const base = pending ? pending.base : rollingBase(repo, recorded, head);
  result.base = base;
  const record = verdict => {
    if (!pending && verdict !== 'skipped' && !result.failures.some(failure => failure.side === 'head')) {
      writeFileSync(`${recordedPath}.tmp`, head);
      renameSync(`${recordedPath}.tmp`, recordedPath);
    }
    const gaps = verdict === 'ok' ? '' : ` incomplete=${result.incomplete.join(',') || '-'} unavailable=${result.unavailable.join(',') || '-'}`;
    const failures = result.failures.length ? ` failure=${result.failures.map(({ side, dir, code }) => `${side}:${dir}:${code}`).join(',')}` : '';
    const invalidated = invalidatedBaseline ? ` invalidatedBaseline=${invalidatedBaseline}` : '';
    const evidence = result.headTree ? ` headTree=${result.headTree} diagnostics=${result.diagnostics}` : '';
    appendFileSync(join(state, 'verdicts.log'), `${new Date().toISOString()} ROLLING-${verdict} scope=${scope} base=${base} head=${head} packages=${result.packages.join(',') || '-'} new=${result.fresh ?? result.attributions.reduce((sum, entry) => sum + entry.rows.length, 0)}${gaps}${failures}${invalidated}${evidence} ${((Date.now() - started) / 1000).toFixed(1)}s${result.attributions.map(entry => ` | ${entry.commit.slice(0, 11)}: ${entry.rows.length}`).join('')}\n`);
  };
  const packages = rollingScopeDirs({ repo, base, head, scope, baseline: needsBaseline });
  result.packages = packages;
  if (!packages.length) { record('skipped'); return result; }
  const treeOf = commit => git(['rev-parse', `${commit}^{tree}`]).trim();
  // Rows come from a worker (P03-INFRA-SWEEP 2026-11-17: ~16 GiB rolling compiles on the agent host); `remote: null`
  // compiles in this process.
  const { rowsAt, rowsAtMany } = treeTypechecker({ repo, state, env, log, compile, bootstrap,
    remote: remote === undefined ? workerTreeRows({ repo, state, env, log, scope }) : remote });
  const readSide = async (tree, side) => {
    const cachedBaseline = side === 'base' && !pending;
    let rows;
    try {
      if (cachedBaseline) {
        [rows] = await rowsAtMany([{ treeId: tree, packages, side }], { cachedOnly: true });
      } else {
        rows = await rowsAt(tree, packages, side);
      }
    } catch (error) {
      log(`[rolling-head-typecheck] ${scope} ${side} comparison-execution-failed: ${error.stack ?? error}`);
      rows = new Map();
      for (const dir of packages) setTypecheckFailure(rows, dir, 'comparison-execution-failed');
    }
    for (const dir of packages) {
      if (isAppScope(dir) && rows.get(dir)?.some(row => row.file === '<global>')) {
        rows.set(dir, null);
        setTypecheckFailure(rows, dir, 'compiler-global-diagnostic');
      }
      if (!rows.get(dir)) {
        result.failures.push({ side, dir, code: rows.failures?.get(dir)
          ?? (cachedBaseline ? 'baseline-unavailable' : 'compiler-incomplete') });
      }
    }
    return rows;
  };
  const headTree = treeOf(head);
  const headRows = await readSide(headTree, 'head');
  const judged = [...headRows.values()].filter(Array.isArray);
  if (judged.length) {
    result.headTree = headTree;
    result.diagnostics = judged.reduce((total, rows) => total + rows.length, 0);
  }
  if (isAppScope(scope) && recorded && !headRows.get(scope)) {
    // A historical compiler cannot recover missing HEAD rows. Keep the last checked checkpoint.
    result.unavailable = [scope];
    record('INCOMPLETE');
    return result;
  }
  // A new baseline needs one exact compile. Log any legacy gap rather than
  // treating a false green as a checked base.
  if (needsBaseline) {
    result.incomplete = packages.filter(dir => !headRows.get(dir));
    record(result.incomplete.length ? 'INCOMPLETE' : 'BASELINE');
    return result;
  }
  const baseTree = treeOf(base);
  const compared = freshBetween(git, baseTree, headTree, packages, await readSide(baseTree, 'base'), headRows);
  result.incomplete = compared.incomplete;
  result.unavailable = compared.unavailable;
  if (!compared.fresh.length) {
    record(compared.incomplete.length || compared.unavailable.length ? 'INCOMPLETE' : 'ok');
    return result;
  }
  // The verdict is decided here. Attribution compiles intermediate commits and can take hours on a
  // long range, so the rolling loop records every scope's verdict first and attributes afterwards
  // (2026-11-16: one packages bisection held every verdict, apps/* included, for 16 h).
  // One commit in the range: the verdict's head compile already names it, so attribution compiles nothing and posts now
  // (a touched app's URGENT goes out with its verdict, not after every other scope's).
  const commits = git(['rev-list', '--first-parent', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  // An earlier unattributed range still pending coalesces with this one instead.
  const single = commits.length === 1 && !existsSync(rollingPendingPath(state, scope));
  if (!attribute && !single) {
    result.fresh = compared.fresh.length;
    // An unattributed earlier range coalesces with this one: attribution runs once, from the oldest
    // unattributed base to the newest RED head, for the errors still present there.
    const path = rollingPendingPath(state, scope);
    const earlier = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    writeFileSync(`${path}.tmp`, JSON.stringify({ base: earlier?.base ?? base, head }));
    renameSync(`${path}.tmp`, path);
    record('RED');
    return result;
  }
  // Bisect, only when red. A diagnostic exists at a commit when it is not new at HEAD relative to that commit.
  // A probe compiles only the packages that still carry an unattributed error; the green ones
  // cannot change an attribution (2026-11-16: 23 packages per probe kept apps/* unreached for hours).
  const presentAt = async (commit, items) => {
    const tree = treeOf(commit);
    if (tree === headTree) return new Set(items);
    const dirs = packages.filter(dir => items.some(item => item.dir === dir));
    const atCommit = await rowsAt(tree, dirs, commit.slice(0, 10));
    const newAtHead = new Set(freshBetween(git, tree, headTree, dirs, atCommit, headRows).fresh.map(({ row }) => row));
    return new Set(items.filter(item => atCommit.get(item.dir) && !newAtHead.has(item.row)));
  };
  let remaining = compared.fresh;
  for (let low = 0; remaining.length;) {
    let [a, b] = [low, commits.length - 1];
    while (a < b) {
      const middle = (a + b) >> 1;
      if ((await presentAt(commits[middle], remaining)).size) b = middle; else a = middle + 1;
    }
    const here = await presentAt(commits[a], remaining);
    result.attributions.push({ commit: commits[a], rows: [...here].map(({ dir, row }) => ({ ...row, package: dir })) });
    remaining = remaining.filter(item => !here.has(item));
    low = a + 1;
  }
  for (const entry of result.attributions) {
    const [subject, author] = git(['log', '-1', '--format=%s%n%an', entry.commit]).trim().split('\n');
    try { post(urgentEntry({ ...entry, subject, author, lane: commitLane(git, entry.commit), base, head })); }
    catch (error) { log(`[rolling-head-typecheck] board post failed for ${entry.commit.slice(0, 11)}: ${error?.message ?? error}`); }
  }
  record(pending ? 'ATTRIBUTED' : 'RED');
  return result;
}

const WORKER_STATE = '.happier-stack/cache/commit-typecheck-worker';
const WORKER_ROWS = 'HAPPIER_ROLLING_ROWS ';

const completeTypecheckRows = (byTree, trees, packages) => trees.every(
  tree => packages.every(dir => Array.isArray(byTree[tree]?.[dir])),
);

// The executor owns the command pool, exclusions and connection addresses.
function typecheckWorkerConnections(repo, env, resourceClass) {
  const launcher = join(repo, 'apps/stack/bin/hstack-exec');
  if (!existsSync(launcher) || process.platform === 'win32') return new Map();
  const output = execFileSync(launcher, [`--execution-workers-with-memory-floor=${resourceClass}`], { cwd: repo, env, encoding: 'utf8' });
  const fields = output.split('\0');
  const connections = new Map();
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [name, alias, config, cliHomeDir, remotePath, floor] = fields.slice(i, i + 6);
    const hostMemoryFloorKiB = Number(floor);
    if (name && alias && config && cliHomeDir && Number.isSafeInteger(hostMemoryFloorKiB) && hostMemoryFloorKiB >= 0) {
      connections.set(name, { alias, config, cliHomeDir, hostMemoryFloorKiB, remotePath: remotePath.split(':').filter(Boolean) });
    }
  }
  // An explicit typecheck preference narrows and orders the executor's pool.
  const override = env.HAPPIER_COMMIT_TYPECHECK_WORKERS;
  if (!override) return connections;
  return new Map(override.split(/\s+/u).filter(name => connections.has(name)).map(name => [name, connections.get(name)]));
}

// Injected worker candidates still obey the executor's exclusion predicate.
function filterExecutionWorkers(workers, env) {
  if (!env.HSTACK_EXEC_PRE_DISPATCH_EXCLUDED_TARGETS) return workers;
  const placement = fileURLToPath(new URL('../../apps/stack/scripts/utils/dev_targets/native_placement.sh', import.meta.url));
  const output = execFileSync('sh', ['-c', '. "$1"; shift; for worker do if ! execution_target_is_excluded "$worker"; then printf "%s\\n" "$worker"; fi; done',
    'sh', placement, ...workers], { env, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

// The committed controller tools are separate from the two judged trees.
// Copy only the gate and executor tools. The compiler and npm inputs are taken
// from each judged tree in the existing warm worktree.
const GIT_WORKER_TOOL_PATHS = [
  'apps/stack/bin', 'apps/stack/scripts/utils', 'scripts/workspaces',
  'scripts/testing/lib/compilerBaseline.mjs', 'scripts/board/postBoardEntry.mjs', 'packages/cli-common',
];

async function runGitTypecheckWorker({ ssh, remoteRepo, controllerTree, entry, args, cwd, env }) {
  const { buildSshWorkerArgs, posixQuote, wrapRemoteScript } = await import('../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs');
  const target = { ...ssh, ssh: ssh.alias, platform: 'posix' };
  const execution = `commit-typecheck-${randomUUID()}`;
  const pidFile = `${ssh.cliHomeDir}/remote-exec/${execution}.pid`;
  const gateArrival = env.HAPPIER_COMMIT_GATE_ARRIVED_AT;
  const command = wrapRemoteScript(target, [
    'set -euo pipefail',
    `repository="$HOME/"${posixQuote(remoteRepo)}`,
    'runner=$(mktemp -d "${repository%/*}/git-worker.XXXXXXXX")',
    `trap 'rm -rf -- "$runner"' EXIT`,
    `git --git-dir "$repository" archive ${posixQuote(controllerTree)} -- ${GIT_WORKER_TOOL_PATHS.map(posixQuote).join(' ')} | tar -xf - -C "$runner"`,
    'cd "$runner"',
    'export HAPPIER_DEV_TARGET_EXECUTION=1',
    `export HAPPIER_ADMISSION_AUTO_HOST_MEMORY_FLOOR_KIB=${ssh.hostMemoryFloorKiB}`,
    ...(gateArrival ? [`export HAPPIER_COMMIT_GATE_ARRIVED_AT=${posixQuote(gateArrival)}`] : []),
    `export HAPPIER_STACK_PM_CACHE_BASE_DIR=${posixQuote(`${ssh.cliHomeDir}/cache`)}`,
    `HAPPIER_REMOTE_EXEC_LIFELINE=1 bash apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh run ${[pidFile, execution].map(posixQuote).join(' ')} node "$runner/"${posixQuote(entry)} ${args.map(posixQuote).join(' ')}`,
  ].join('\n'));
  const sshArgs = buildSshWorkerArgs(target, {
    remoteCommand: command, sshArgs: ['-F', ssh.config, '-o', 'ConnectTimeout=20'], tty: false,
  });
  return await new Promise(resolveResult => {
    const child = spawn('ssh', sshArgs, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    // Open stdin is the existing remote custody lifeline. The local gate
    // leaving closes it, including when the controller process is interrupted.
    const output = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => output.push(chunk));
    child.stdin.on('error', () => {});
    let failure;
    child.on('error', error => { failure = error; });
    child.on('close', (status, signal) => resolveResult({ status, signal, stdout: output.join(''), failure }));
  });
}

/**
 * Ships the Git trees incrementally to the worker selected from the executor's pool. The worker runs the committed
 * controller tools with the executor's SSH and custody, and materializes each judged tree in its warm worktree under
 * its own compiler admission. No Mutagen mirror is involved.
 * Unreachable or failed: every package is null (INCOMPLETE in verdicts.log); never a controller compile.
 */
export function workerTreeRows({ repo, state, env = process.env, log = message => process.stderr.write(`${message}\n`), scope = 'packages',
  workers, lane = '', entry = 'scripts/workspaces/commitPackageTypecheck.mjs', transport }) {
  const slug = basename(state);
  const remoteRepo = `${WORKER_STATE}/${slug}/repo.git`;
  if (!/^[A-Za-z0-9._-]+$/u.test(slug) || slug === '.' || slug === '..') throw new Error('Invalid commit typecheck state name');
  // SSH/process boundary for both Git transport and process custody.
  const sshCommandOf = ssh => `ssh -F '${ssh.config.replaceAll("'", "'\\''")}' -o BatchMode=yes -o ConnectTimeout=20`;
  const io = transport ?? {
    listRefs: (ssh, refs) => {
      const listed = spawnSync('git', ['ls-remote', `${ssh.alias}:${remoteRepo}`, ...refs], { cwd: repo, encoding: 'utf8', env: { ...gitEnv(), GIT_SSH_COMMAND: sshCommandOf(ssh) } });
      return listed.status === 0 ? listed.stdout : '';
    },
    // A worker whose system git sets core.sharedRepository makes init write receive.denyNonFastForwards=true, which
    // rejected every push after the first (nl3, 2026-11-17 14:18Z onward: ~60 s lost per tree before falling back to nl1).
    push: (ssh, commit, target) => {
      const init = spawnSync('sh', ['-c', `${sshCommandOf(ssh)} "$1" "git init --quiet --bare -b rolling '${remoteRepo}' >/dev/null && git -C '${remoteRepo}' config receive.denyNonFastForwards false"`, 'sh', ssh.alias], { encoding: 'utf8' });
      if (init.status !== 0) return init;
      return spawnSync('git', ['push', '--quiet', '--force', `${ssh.alias}:${remoteRepo}`, `${commit}:${target}`],
        { cwd: repo, encoding: 'utf8', env: { ...gitEnv(), GIT_SSH_COMMAND: sshCommandOf(ssh) } });
    },
    dispatch: (_worker, args, ssh, controllerTree) => runGitTypecheckWorker({
      ssh, remoteRepo, controllerTree, entry, args, cwd: repo, env,
    }),
  };
  const ref = lane ? `rolling-${lane}` : 'rolling';
  const git = gitAt(repo);
  // `(treeId, dirs, side)` -> Map dir -> rows; `([treeIds], dirs, [sides])` -> Map treeId -> (Map dir -> rows), all trees in
  // one push and one worker request.
  return async (treeId, dirs, side) => {
    const many = Array.isArray(treeId);
    const treeIds = many ? treeId : [treeId];
    const sides = many ? side : [side];
    const label = sides.join('+');
    const unjudged = () => new Map(dirs.map(dir => [dir, undefined]));
    const none = many ? new Map(treeIds.map(id => [id, unjudged()])) : unjudged();
    const unavailable = code => {
      const sides = many ? none.values() : [none];
      for (const rows of sides) for (const dir of dirs) setTypecheckFailure(rows, dir, code);
      return none;
    };
    const resourceClass = lane === GATE_LANE ? GATE_PACKAGE_CHECK_CLASS : 'compilation';
    const connections = transport ? undefined : typecheckWorkerConnections(repo, env, resourceClass);
    const [worker] = transport ? filterExecutionWorkers(workers ?? [], env)
      : workers ? workers.filter(worker => connections.has(worker)) : connections.keys();
    if (!worker) return unavailable('worker-unavailable');
    const ssh = transport ? io.ssh(worker) : connections.get(worker);
    if (!ssh) return unavailable('worker-unavailable');
    const controllerTree = transport ? undefined : git(['rev-parse', 'HEAD^{tree}']).trim();
    // Each candidate tree, and the Git-only runner, must be reachable from the
    // one published tip. Append the runner first so the tip remains a judged tree.
    const publishedTrees = controllerTree && !treeIds.includes(controllerTree) ? [controllerTree, ...treeIds] : treeIds;
    // Each tree is pushed as a child of the last commit this worker accepted on the ref. A parentless commit made
    // the push enumerate and send the whole tree (71,501 objects, 155-300 s per tree on 2026-11-18); a child of a
    // commit the worker has sends only the changed objects (14 objects, 3.5 KB, under a second, for 5f6edbb072d).
    const tipPath = join(state, `worker-${worker}-${ref}.tip`);
    let parent = '';
    try { parent = readFileSync(tipPath, 'utf8').trim(); } catch {}
    const known = rev => spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: repo, env: gitEnv() }).status === 0;
    if (parent && !known(parent)) parent = '';
    if (!parent) {
      // No recorded tip (a new state or lane): any commit the worker's refs already name and this repository holds.
      parent = io.listRefs(ssh, [`refs/heads/${ref}`, 'refs/heads/rolling']).split('\n').map(line => line.split('\t')[0]).find(rev => rev && known(rev)) ?? '';
    }
    // The trees chain in request order, so one push of the last carries them all.
    let commit = parent;
    for (const id of publishedTrees) {
      commit = commit && git(['rev-parse', `${commit}^{tree}`]).trim() === id ? commit
        : typecheckTreeCommit(git, id, commit);
    }
    // A push may replace the ref with an unrelated chain (another controller state).
    const push = io.push(ssh, commit, `refs/heads/${ref}`);
    if (push.status !== 0) {
      log(`[rolling-head-typecheck] worker ${worker} unreachable for ${label}: ${(push.stderr || '').trim().split('\n').at(-1) ?? ''}`);
      return unavailable('worker-git-push-failed');
    }
    writeFileSync(`${tipPath}.${process.pid}`, commit);
    renameSync(`${tipPath}.${process.pid}`, tipPath);
    const run = await io.dispatch(worker, ['--worker-rows', `--slug=${slug}`, ...(lane ? [`--lane=${lane}`] : []), `--ref=${ref}`, `--scope=${scope}`,
      `--tree=${treeIds.join(',')}`, `--packages=${dirs.join(',')}`, `--side=${sides.join(',')}`], ssh, controllerTree);
    const line = run.status === 0 && run.stdout?.split('\n').find(entry => entry.startsWith(WORKER_ROWS));
    if (!line) {
      log(`[rolling-head-typecheck] worker ${worker} returned no rows for ${label} (${run.failure?.code ?? run.status ?? run.signal})`);
      return unavailable('worker-no-rows');
    }
    let fetched;
    try { fetched = JSON.parse(line.slice(WORKER_ROWS.length)); }
    catch (error) {
      log(`[rolling-head-typecheck] worker ${worker} returned invalid rows for ${label}: ${error.message}`);
      return unavailable('worker-invalid-rows');
    }
    const byTree = new Map();
    for (const id of treeIds) {
      const rows = new Map();
      for (const dir of dirs) {
        const value = fetched[id]?.[dir];
        rows.set(dir, Array.isArray(value) ? value : null);
        if (typeof value?.failure === 'string') setTypecheckFailure(rows, dir, value.failure);
      }
      byTree.set(id, rows);
    }
    return many ? byTree : byTree.get(treeId);
  };
}

async function withControllerDeclarationScratch(env, run) {
  const { assertCommitGateDisk, commitGateScratchRoot } = await import('./commitGateScratch.mjs');
  assertCommitGateDisk(env);
  const scratch = mkdtempSync(join(commitGateScratchRoot(env), 'happier-controller-declarations-'));
  const stop = new AbortController();
  const interrupt = signal => stop.abort(signal);
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, interrupt);
  try {
    const result = await run(scratch, stop.signal);
    return { result, cancelled: stop.signal.aborted };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } finally {
      for (const signal of signals) process.off(signal, interrupt);
    }
  }
}

/** The scoped gate can judge locally with the controller's published install. */
function controllerDeclarationRows({ repo, env, log, requireInherited }) {
  return async (trees, packages, sides) => {
    const { getForegroundCommandResult, spawnForegroundCommand } = await import('../../apps/stack/scripts/utils/proc/proc.mjs');
    const { result: run, cancelled } = await withControllerDeclarationScratch(env, async (scratch, stop) => {
      const request = { repo, trees, packages, sides, scratch };
      log(`[commit-package-typecheck] controller declaration comparison for ${sides.join('+')} (${trees.join(', ')}) scratch=${scratch}`);
      const [executable, ...args] = admittedCommand(repo, [process.execPath, COMMIT_GATE_TYPECHECK_ENTRY, '--compiler-admitted'],
        false, packages.join('\n'), GATE_DECLARATION_COMPARISON_CLASS, { trees, files: packages }, join(repo, 'apps/stack/bin/hstack-exec'));
      if (requireInherited && process.platform !== 'win32') args.splice(args.indexOf('--'), 0, '--require-inherited');
      // Wait for the owned process group to stop before removing its scratch.
      return await new Promise(resolve => {
        const child = spawnForegroundCommand(executable, args, { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'],
          signal: stop, ownedProcessGroup: true,
          env: { ...compileEnvOf(env), HAPPIER_COMMIT_TYPECHECK_CONTROLLER_REQUEST: JSON.stringify(request) } });
        let stdout = '';
        let failure;
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.on('error', error => { failure = error; });
        child.on('close', (nativeCode, nativeSignal) => {
          const { status, signal } = getForegroundCommandResult(child, nativeCode, nativeSignal);
          if (status !== 0 || failure) log(`[commit-package-typecheck] controller comparison incomplete (${stop.reason ?? failure?.code ?? signal ?? status})`);
          resolve({ ok: status === 0 && !failure, stdout });
        });
      });
    });
    if (cancelled) return Object.assign(new Map(), { cancelled: true });
    if (!run.ok) return new Map();
    const line = run.stdout.split('\n').find(entry => entry.startsWith(WORKER_ROWS));
    if (!line) return new Map();
    let rows;
    try { rows = JSON.parse(line.slice(WORKER_ROWS.length)); }
    catch (error) { log(`[commit-package-typecheck] controller returned invalid rows: ${error.message}`); return new Map(); }
    return new Map(trees.map(tree => [tree, new Map(Object.entries(rows[tree] ?? {}))]));
  };
}

// Use pnpm's installed graph, which stays pinned to the publication even when
// the moving checkout has already edited its own manifests and lockfile.
function readPnpmDependencyGraph(path) {
  if (!existsSync(path)) return null;
  const { parseAllDocuments } = createRequire(import.meta.url)('yaml');
  const documents = parseAllDocuments(readFileSync(path, 'utf8'));
  if (documents.some(doc => doc.errors.length)) return null;
  // pnpm writes its package-manager configuration in an earlier YAML document.
  const graph = documents.at(-1)?.toJS();
  return String(graph?.lockfileVersion) === '9.0' && graph.importers ? graph : null;
}

function externalImporterDependencies(importers, dir) {
  const importer = importers[dir === '' ? '.' : dir];
  return Object.fromEntries(['dependencies', 'optionalDependencies', 'devDependencies'].flatMap(section => {
    const resolutions = Object.entries(importer?.[section] ?? {}).flatMap(([name, dependency]) => {
      const version = dependency?.version;
      // Workspace links are supplied by the judged tree. A file link outside
      // the package's workspace graph still needs the canonical exact install.
      return typeof version === 'string' && version.startsWith('link:')
        && Object.hasOwn(importers, posix.normalize(posix.join(dir, version.slice(5))))
        ? [] : [[name, version]];
    });
    return resolutions.length ? [[section, Object.fromEntries(resolutions)]] : [];
  }));
}

function canMountPublishedDependencies(selected, installed, dirs) {
  if (!selected || !installed) return false;
  const { importers, packages = {}, snapshots = {} } = selected;
  const { importers: installedImporters, packages: installedPackages = {}, snapshots: installedSnapshots = {} } = installed;
  const pending = [];
  for (const dir of ['', ...dirs]) {
    const required = externalImporterDependencies(importers, dir);
    if (!isDeepStrictEqual(required, externalImporterDependencies(installedImporters, dir))) return false;
    for (const section of Object.values(required)) pending.push(...Object.entries(section));
  }
  const checked = new Set();
  for (const [name, version] of pending) {
    if (typeof version !== 'string') return false;
    const key = Object.hasOwn(snapshots, version) ? version : `${name}@${version}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const snapshot = snapshots[key];
    const packageKey = key.split('(')[0];
    if (!snapshot || !packages[packageKey] || !isDeepStrictEqual(snapshot, installedSnapshots[key])
      || !isDeepStrictEqual(packages[packageKey], installedPackages[packageKey])) return false;
    pending.push(...Object.entries(snapshot.dependencies ?? {}), ...Object.entries(snapshot.optionalDependencies ?? {}));
  }
  return true;
}

async function compileControllerDeclarations({ repo, trees, packages, sides, scratch }, signal) {
  const { assertCommitGateDisk } = await import('./commitGateScratch.mjs');
  const { extractRevision } = await import('../../apps/stack/scripts/build/source_revision_install.mjs');
  const { mountCapturedWorkspaceDependencies } = await import('./buildInputConvergence.mjs');
  const { inspectDependencyRefresh, readDependencyPublicationState, withDependencyConsumption } = await import('../../apps/stack/scripts/utils/proc/dependency_refresh.mjs');
  const log = message => console.error(message);
  const byTree = {};
  try {
    // Hold one publication across both verdicts, materializing one Git tree
    // at a time. Archiving the whole tree preserves compiler inputs outside
    // the package closure, including root configuration and generated inputs.
    await withDependencyConsumption({ installDir: repo, signal, wait: false }, async admittedEnv => {
      const installed = await readDependencyPublicationState({ installDir: repo });
      let publishedLock;
      for (const [index, tree] of trees.entries()) {
        signal?.throwIfAborted();
        const side = sides[index];
        const state = join(scratch, String(index));
        const worktree = join(state, 'worktree');
        try {
          assertCommitGateDisk(admittedEnv, scratch);
          mkdirSync(worktree, { recursive: true });
          await extractRevision({ repoDir: repo, revision: tree, outputDir: worktree });
          const selected = await inspectDependencyRefresh({ installDir: worktree });
          const workspaces = readCommitTreeWorkspacePackages(repo, tree);
          if (selected.installIdentity !== installed.identity) {
            const roots = [...workspaces].filter(([, workspace]) => packages.includes(workspace.root)).map(([name]) => name);
            const closure = workspaceSourcePackageClosure(workspaces, roots);
            const closureDirs = [...closure].map(name => workspaces.get(name).root);
            if (publishedLock === undefined) {
              publishedLock = installed.identity ? readPnpmDependencyGraph(join(repo, 'node_modules', '.pnpm', 'lock.yaml')) : null;
            }
            if (!canMountPublishedDependencies(readPnpmDependencyGraph(join(worktree, 'pnpm-lock.yaml')), publishedLock, closureDirs)) {
              log(`[commit-package-typecheck] ${side} controller installation does not match the judged external dependency closure`);
              continue;
            }
          }
          const dirs = [...workspaces.values()].map(workspace => workspace.root);
          await mountCapturedWorkspaceDependencies({ sourceDir: repo, captureDir: worktree, workspaceDirs: dirs, capturedOnly: true });
          signal?.throwIfAborted();
          // Keep compiler emit directories inside the dispatcher's lifetime as well.
          const env = { ...admittedEnv, HAPPIER_HSTACK_EXECUTION: '1', TMPDIR: state, TMP: state, TEMP: state };
          const { rowsAt } = treeTypechecker({ repo, state, env, log, capturedWorktree: worktree });
          byTree[tree] = Object.fromEntries(rowsAt(tree, packages, side));
        } finally {
          rmSync(state, { recursive: true, force: true });
        }
      }
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) return 2;
    log(`[commit-package-typecheck] controller comparison incomplete: ${error.message}`);
  }
  process.stdout.write(`${WORKER_ROWS}${JSON.stringify(byTree)}\n`);
  return completeTypecheckRows(byTree, trees, packages) ? 0 : 2;
}

/** Worker side of workerTreeRows: compile the shipped tree in this host's warm worktree under its own broker. A lane
 * (`--lane=gate`) has its own worktree, lock and incremental state under the slug, beside the shared bare repository. */
async function workerRows(argv, entry) {
  if (process.env.HAPPIER_DEV_TARGET_EXECUTION !== '1') {
    console.error('[rolling-head-typecheck] --worker-rows runs only on an execution host (hstack-exec --target=<worker>)');
    return 2;
  }
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
  const slug = option('slug');
  if (!/^[A-Za-z0-9._-]+$/u.test(slug) || slug === '.' || slug === '..') {
    console.error('[rolling-head-typecheck] invalid worker state name');
    return 2;
  }
  const slugState = join(homedir(), WORKER_STATE, slug);
  const lane = option('lane');
  if (lane && !/^[a-z]+$/u.test(lane)) { console.error('[rolling-head-typecheck] --lane must be lowercase letters'); return 2; }
  const state = lane ? join(slugState, `lane-${lane}`) : slugState;
  const retireOnFinish = lane && lane !== GATE_LANE;
  const request = { trees: option('tree').split(',').filter(Boolean), packages: option('packages').split(',').filter(Boolean),
    sides: option('side').split(','), repo: join(slugState, 'repo.git'), ref: option('ref') || 'rolling', gate: lane === GATE_LANE };
  const scope = option('scope') || 'packages';
  if (!request.trees.length || !request.packages.length) { console.error('[rolling-head-typecheck] --worker-rows needs --slug, --tree and --packages'); return 2; }
  // A scoped Git runner has a temporary root. Keep the broker's entry identity stable.
  const workerEntry = relative(process.cwd(), entry);
  const payload = [process.execPath, ...process.execArgv, workerEntry, '--compiler-admitted'];
  mkdirSync(state, { recursive: true });
  // A lane's compile identity names its packages, so the broker sizes each from its own recorded compile peak.
  const projects = lane ? request.packages.join('\n') : scope === 'packages' ? undefined : scope;
  return await withWorkspaceBundleLock(async ({ assertOwned }) => {
    const prepare = treeDependencyPreparer({ repo: request.repo, state, env: process.env, worktreeRev: request.ref });
    const className = request.gate ? GATE_PACKAGE_CHECK_CLASS
      : scope === 'apps/cli' ? 'compilation-cli' : 'compilation';
    const rows = {};
    try {
      for (const [index, tree] of request.trees.entries()) {
        const job = { ...request, trees: [tree], sides: [request.sides[index]] };
        const workerEnv = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state,
          HAPPIER_COMMIT_TYPECHECK_WORKER_REQUEST: JSON.stringify(job) };
        // Admission for the previous tree has ended before a new generation can install.
        if (!prepare.prepared(tree)) {
          const step = admittedCommand(state, [process.execPath, ...process.execArgv, workerEntry, '--prepare-dependencies'],
            false, undefined, 'dependency-install');
          const prepared = spawnSync(step[0], step.slice(1), { env: workerEnv, stdio: 'inherit' });
          if (prepared.error) throw prepared.error;
          if (prepared.status !== 0) return prepared.status ?? 2;
        }
        const command = admittedCommand(state, payload, false, projects, className, { trees: [tree], files: request.packages });
        const child = spawn(command[0], command.slice(1), { env: workerEnv, stdio: ['inherit', 'pipe', 'inherit'] });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        const [status] = await once(child, 'close');
        // Preserve the worker dispatch's result envelope and diagnostics.
        for (const line of output.trimEnd().split('\n')) {
          if (line.startsWith(WORKER_ROWS)) Object.assign(rows, JSON.parse(line.slice(WORKER_ROWS.length)));
          else if (line) process.stdout.write(line + '\n');
        }
        if (status !== 0 || !Object.hasOwn(rows, tree)) return status || 2;
      }
    } finally {
      // Rolling and commit-gate worktrees serve future jobs. A named ad hoc
      // lane returns its rows to the controller and can retire under this lock.
      if (retireOnFinish) {
        assertOwned();
        const worktree = join(state, 'worktree');
        if (existsSync(join(worktree, '.git'))) {
          gitAt(request.repo)(['worktree', 'remove', '--force', '--force', worktree]);
        }
        for (const name of ['declarations', 'results', 'dependencies-generation', 'worktree-tree']) {
          rmSync(join(state, name), { recursive: true, force: true });
        }
      }
    }
    process.stdout.write(`${WORKER_ROWS}${JSON.stringify(rows)}\n`);
    return 0;
  }, { lockPath: join(state, 'worktree.lock'), timeoutMs: null, wait: lane !== GATE_LANE }).catch(error => {
    if (error?.code !== WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) throw error;
    console.error('[rolling-head-typecheck] exact-tree worker worktree busy');
    return 2;
  });
}

const rollingPendingPath = (state, scope) => join(state, `attribution-pending-${scope.replaceAll('/', '__')}.json`);

/** Attributes a range whose RED verdict was recorded earlier (bisects and posts), then clears it. */
export async function attributeRollingRange({ repo, env = process.env, scope = 'packages', ...options }) {
  const path = rollingPendingPath(commitPackageTypecheckStateDir(repo, env), scope);
  if (!existsSync(path)) return null;
  const pending = JSON.parse(readFileSync(path, 'utf8'));
  const result = await rollingHeadTypecheckPass({ repo, env, scope, ...options, pending });
  rmSync(path, { force: true });
  return result;
}

/**
 * Commit paths call this after HEAD moved (commit-partial.sh, commitFromPrivateIndex, the coherence
 * finalizer). It never waits: it starts the single rolling owner detached, which exits at once when a
 * check already holds the warm worktree (that holder re-reads HEAD before it lets go).
 */
export function kickRollingHeadTypecheck({ repo, env = process.env, commit }) {
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
  // The landed commit's gate typecheck in report-and-URGENT mode (P03 ORCH 2026-11-18): its own detached process and
  // worker lane, only for a commit that touches packages/* or packages/plugins/* workspaces.
  if (commit && (commitGateTypecheckPlan({ repo, base: `${commit}^`, tree: commit }).blocking.length || hasBroadCommitReplay(repo, commit))) {
    queueCommitGateReport({ repo, env, commit });
    const reportLog = openSync(join(state, 'runs', 'gate-report.log'), 'a');
    try {
      for (const worker of typecheckWorkerConnections(repo, env, GATE_PACKAGE_CHECK_CLASS).keys()) {
        spawn(process.execPath, [fileURLToPath(new URL('./commitGateTypecheck.mjs', import.meta.url)), '--report-queue', `--worker=${worker}`],
          { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', reportLog, reportLog] }).unref();
      }
    } finally {
      closeSync(reportLog);
    }
  }
  // The same kick moves the QA green pointer (owner 2026-11-18): its own lock and state, never this worktree.
  const greenCheck = fileURLToPath(new URL('../../apps/stack/scripts/stack/qa_green.mjs', import.meta.url));
  if (existsSync(greenCheck)) {
    const greenLog = openSync(join(state, 'runs', 'qa-green.log'), 'a');
    try {
      spawn(process.execPath, [greenCheck, '--rolling', repo], { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', greenLog, greenLog] }).unref();
    } finally {
      closeSync(greenLog);
    }
  }
  return `rolling HEAD typecheck kicked; verdicts in ${join(state, 'verdicts.log')}`;
}

let rollingOwner = false;
function admittedCommand(repo, payload, cached, projects, className = 'compilation', judgment, launcher = fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url))) {
  // Native Windows has no shell admission; it runs the payload directly (as the checker does).
  // The admitted argv is the admission identity: only stable arguments, so the broker sizes it from
  // this identity's recorded kernel peak; the request travels in env.
  // The rolling owner compiles nothing here: its rows come from a worker that admits there (workerTreeRows).
  return cached || rollingOwner || process.platform === 'win32' ? payload : [launcher,
    '--heavyweight-admission', `--class=${className}`, `--machine=${process.env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
    ...(projects ? [`--projects=${projects}`] : []),
    ...(judgment ? [`--judged-trees=${judgment.trees.join(',')}`, ...judgment.files.map(file => `--judged-file=${file}`)] : []),
    '--exec-admitted', '--', ...payload];
}

/** The next scope a rolling pass compiles: packages (minutes) whenever it is behind and did not run last, so its
 * verdict never waits behind more than one hour-long app compile (P03-TYPECHECK-DEBT 2026-11-17); otherwise the behind
 * app after `lastApp`, in turn, so a HEAD that moves during every pass still reaches each app. */
export function nextRollingScope({ pending, lastScope, lastApp }) {
  if (pending.includes('packages') && (lastScope !== 'packages' || pending.length === 1)) return 'packages';
  const start = ROLLING_APP_SCOPES.indexOf(lastApp) + 1;
  return [...ROLLING_APP_SCOPES.slice(start), ...ROLLING_APP_SCOPES.slice(0, start)].find(scope => pending.includes(scope));
}

/** Run each pending scope against the current HEAD, refreshing it after every pass. */
export async function runRollingVerdictRound({ scopes, head, recorded, run, log }) {
  const stalled = new Set();
  let lastApp, lastScope;
  for (;;) {
    const current = head();
    const pending = scopes.filter(scope => recorded(scope) !== current && !stalled.has(`${scope}@${current}`));
    const scope = nextRollingScope({ pending, lastScope, lastApp });
    if (!scope) return scopes.some(scope => recorded(scope) !== current) ? current : undefined;
    lastScope = scope;
    const before = recorded(scope);
    const status = await run(scope, before, current);
    // A turn is consumed by an attempt, even if the compiler leaves the checkpoint in place.
    if (scope !== 'packages') lastApp = scope;
    if (recorded(scope) === before) {
      log(`[rolling-head-typecheck] ${scope} pass exit=${status} recorded nothing; waiting for the next HEAD move`);
      stalled.add(`${scope}@${current}`);
    }
  }
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
    let stalledHead;
    try {
      stalledHead = await withWorkspaceBundleLock(async () => {
        const stalled = await runRollingVerdictRound({
          scopes, head, recorded, log: console.error,
          run: (scope, before, current) => {
            ensureWorktree(repo, worktree);
            const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_ROLLING: '1', HAPPIER_COMMIT_TYPECHECK_REPO: repo,
              HAPPIER_COMMIT_TYPECHECK_LOCKED: '1', HAPPIER_COMMIT_TYPECHECK_SCOPE: scope };
            // A range with nothing to compile for this scope needs no admission slot.
            const idle = !rollingScopeDirs({ repo, base: rollingBase(repo, before, current), head: current, scope, baseline: !before }).length;
            const command = admittedCommand(repo, payload, idle, scope === 'packages' ? undefined : scope);
            const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env, stdio: 'inherit' });
            if (result.error) throw result.error;
            return result.status;
          },
        });
        if (stalled) return stalled;
        // Every scope has its verdict for the newest HEAD; attribute recorded RED ranges now. A HEAD
        // move meanwhile is picked up by the outer loop, verdicts first again.
        for (const scope of scopes) {
          if (!existsSync(rollingPendingPath(state, scope))) continue;
          ensureWorktree(repo, worktree);
          const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_ROLLING: '1', HAPPIER_COMMIT_TYPECHECK_REPO: repo,
            HAPPIER_COMMIT_TYPECHECK_LOCKED: '1', HAPPIER_COMMIT_TYPECHECK_SCOPE: scope, HAPPIER_COMMIT_TYPECHECK_PHASE: 'attribute' };
          const command = admittedCommand(repo, payload, false, scope === 'packages' ? undefined : scope);
          const result = spawnSync(command[0], command.slice(1), { cwd: worktree, env, stdio: 'inherit' });
          if (result.error) throw result.error;
          if (behind().length) break;
        }
      }, { lockPath: join(state, 'worktree.lock'), timeoutMs: null, wait: false });
    } catch (error) {
      if (error?.code === WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) return 0; // the holder re-reads HEAD before releasing
      throw error;
    }
    // Closes the window between the holder's last HEAD read and its release.
    if (stalledHead === head() || !behind().length) return 0;
  }
}

/** CLI; `entry` is the script the worker admits (commitGateTypecheck.mjs runs the same CLI under its own identity). */
export async function commitPackageTypecheckMain(argv, entry = fileURLToPath(import.meta.url)) {
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[name];
  if (argv.includes('--worker-rows')) return await workerRows(argv, entry);
  if (argv.includes('--prepare-dependencies') && process.env.HAPPIER_COMMIT_TYPECHECK_WORKER_REQUEST) {
    // Admitted on the worker as a dependency-install step for the selected tree.
    const request = JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_WORKER_REQUEST);
    treeDependencyPreparer({ repo: request.repo, state: process.env.HAPPIER_COMMIT_TYPECHECK_DIR, env: process.env,
      log: message => process.stderr.write(`${message}\n`), worktreeRev: request.ref ?? 'rolling' })(request.trees[0]);
    return 0;
  }
  if (argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_CONTROLLER_REQUEST) {
    const request = JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_CONTROLLER_REQUEST);
    if (request.scratch) return await compileControllerDeclarations(request);
    // A queued dispatcher can start the current child with the earlier request shape.
    const { result, cancelled } = await withControllerDeclarationScratch(process.env, (scratch, signal) => {
      console.error(`[commit-package-typecheck] retained controller declaration request scratch=${scratch}`);
      return compileControllerDeclarations({ ...request, scratch }, signal);
    });
    return cancelled ? 2 : result;
  }
  if (argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_WORKER_REQUEST) {
    // Admitted on the worker: rows for one tree in the worker's warm worktree.
    const state = process.env.HAPPIER_COMMIT_TYPECHECK_DIR;
    const request = JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_WORKER_REQUEST);
    const { rowsAt } = treeTypechecker({ repo: request.repo ?? join(state, 'repo.git'), state, env: process.env,
      log: message => process.stderr.write(`${message}\n`), worktreeRev: request.ref ?? 'rolling' });
    const byTree = Object.fromEntries(request.trees.map((tree, index) => {
      const rows = rowsAt(tree, request.packages, request.sides[index] || tree.slice(0, 10));
      return [tree, Object.fromEntries([...rows].map(([dir, value]) => {
        const failure = rows.failures?.get(dir);
        return [dir, failure ? { failure } : value];
      }))];
    }));
    process.stdout.write(`${WORKER_ROWS}${JSON.stringify(byTree)}\n`);
    // A known environmental failure is a usable worker response. Passing it
    // through keeps the failed scope out of the controller's diagnostic delta.
    return !request.gate || request.trees.every(tree => request.packages.every(dir => {
      const value = byTree[tree][dir];
      return Array.isArray(value) || workspaceOutputFailure(value?.failure);
    })) ? 0 : 2;
  }
  if (argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_ROLLING === '1') {
    const options = { repo: process.env.HAPPIER_COMMIT_TYPECHECK_REPO, scope: process.env.HAPPIER_COMMIT_TYPECHECK_SCOPE || 'packages' };
    const result = process.env.HAPPIER_COMMIT_TYPECHECK_PHASE === 'attribute'
      ? await attributeRollingRange(options) : await rollingHeadTypecheckPass({ ...options, attribute: false });
    if (!result) return 0;
    console.log(`[rolling-head-typecheck] ${result.scope} ${result.base.slice(0, 11)}..${result.head.slice(0, 11)} packages=${result.packages.length} attributions=${result.attributions.map(entry => `${entry.commit.slice(0, 11)}:${entry.rows.length}`).join(',') || 'none'}`);
    return result.failures.length ? 2 : 0;
  }
  const admitted = argv.includes('--compiler-admitted') && process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST;
  if (admitted) {
    const repo = process.env.HAPPIER_COMMIT_TYPECHECK_REPO;
    let refused = 0;
    for (const target of JSON.parse(process.env.HAPPIER_COMMIT_TYPECHECK_REQUEST)) {
      const result = await commitPackageTypecheck({ repo, base: target.base, tree: target.tree, scope: target.scope });
      if (commitPackageTypecheckRefuses(result)) refused += 1;
      console.log(`${commitPackageTypecheckRefuses(result) ? 'INCOHERENT' : 'coherent'} ${target.label}: ${formatCommitPackageTypecheck(result).join('\n')}`);
      console.log(`[commit-package-typecheck-timings] ${JSON.stringify({ label: target.label, lockWaitMs: result.lockWaitMs, ms: result.ms, timings: result.timings })}`);
    }
    return refused ? 1 : 0;
  }
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (argv.includes('--kick')) {
    const commit = argv.find(arg => arg.startsWith('--commit='))?.slice('--commit='.length);
    console.log(kickRollingHeadTypecheck({ repo, commit: commit && execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim() }));
    return 0;
  }
  if (argv.includes('--rolling')) { rollingOwner = true; return await rolling(repo); }
  // By hand: one or more packets, each against its parent (or --base/--tree).
  const rev = spec => execFileSync('git', ['rev-parse', '--verify', spec], { cwd: repo, encoding: 'utf8' }).trim();
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (option('scope')) {
    const scope = option('scope');
    if (!option('tree')) {
      console.error('usage: commitPackageTypecheck.mjs --scope=<apps/ui|apps/cli|apps/server> --tree=<revision>');
      return 2;
    }
    const tree = rev(`${option('tree')}^{tree}`);
    const state = commitPackageTypecheckStateDir(repo);
    mkdirSync(state, { recursive: true });
    const remote = workerTreeRows({ repo, state, scope, lane: 'replay' });
    const result = await commitPackageTypecheck({ repo, tree, scope, remote });
    console.log(`[typecheck-replay] tree=${tree} scope=${scope}`);
    for (const line of formatCommitPackageTypecheck(result)) console.log(line);
    return result.incomplete.length || result.unavailable.length ? 2 : result.fresh.length ? 1 : 0;
  }
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
    process.exitCode = await commitPackageTypecheckMain(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stderr?.toString?.() || error?.message || error);
    process.exitCode = 2;
  }
}
