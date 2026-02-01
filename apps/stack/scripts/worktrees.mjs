import './utils/env/env.mjs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { commandExists, resolveCommandPath } from './utils/proc/commands.mjs';
import {
  coerceHappyMonorepoRootFromPath,
  getComponentRepoDir,
  getHappyStacksHomeDir,
  getRootDir,
  getRepoDir,
  getWorkspaceDir,
  resolveStackEnvPath,
} from './utils/paths/paths.mjs';
import { getWorktreesRoot, inferRemoteNameForOwner, listWorktreeSpecs, parseGithubOwner, resolveComponentSpecToDir } from './utils/git/worktrees.mjs';
import { parseGithubPullRequest, sanitizeSlugPart } from './utils/git/refs.mjs';
import { readTextIfExists } from './utils/fs/ops.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { ensureEnvFilePruned, ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';
import { applyStackCacheEnv } from './utils/proc/pm.mjs';
import { existsSync } from 'node:fs';
import { getHomeEnvLocalPath, getHomeEnvPath, resolveUserConfigEnvPath } from './utils/env/config.mjs';
import { detectServerComponentDirMismatch } from './utils/server/validate.mjs';
import { listAllStackNames } from './utils/stack/stacks.mjs';
import { parseDotenv } from './utils/env/dotenv.mjs';
import { bold, cyan, dim, green } from './utils/ui/ansi.mjs';

const DEFAULT_REPO_COMPONENT = 'happy';
const REPO_DIR_ENV_KEY = 'HAPPIER_STACK_REPO_DIR';

function getActiveStackName() {
  return (process.env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
}

function isMainStack() {
  return getActiveStackName() === 'main';
}

function worktreeRepoKeyForComponent(rootDir, component) {
  // Worktrees are repo-scoped (monorepo-only) and no longer nested by component key.
  void rootDir;
  void component;
  return '';
}

function getActiveRepoDir(rootDir) {
  return getRepoDir(rootDir, process.env);
}

function getDefaultRepoDir(rootDir) {
  // Clone env so we can suppress the override for this lookup.
  const env = { ...process.env, [REPO_DIR_ENV_KEY]: '' };
  return getRepoDir(rootDir, env);
}

function resolveComponentWorktreeDir({ rootDir, component, spec }) {
  const raw = (spec ?? '').trim();
  void component;

  if (!raw) {
    // Default: current active repo dir (env override if present, otherwise <workspace>/happier).
    return getActiveRepoDir(rootDir);
  }

  if (raw === 'default' || raw === 'main') {
    return getDefaultRepoDir(rootDir);
  }

  if (raw === 'active') {
    return getActiveRepoDir(rootDir);
  }

  if (!isAbsolute(raw)) {
    // Allow passing a workspace-relative path as an escape hatch.
    const rel = resolve(getWorkspaceDir(rootDir), raw);
    if (existsSync(rel)) {
      return coerceHappyMonorepoRootFromPath(rel) ?? rel;
    }
  }

  // Absolute paths and <owner>/<branch...> specs.
  const resolved = resolveComponentSpecToDir({ rootDir, component: DEFAULT_REPO_COMPONENT, spec: raw });
  if (resolved) {
    return coerceHappyMonorepoRootFromPath(resolved) ?? resolved;
  }

  // Fallback: treat raw as a literal path.
  if (isAbsolute(raw)) {
    return coerceHappyMonorepoRootFromPath(raw) ?? raw;
  }
  return null;
}

async function isWorktreeClean(dir) {
  const dirty = (await git(dir, ['status', '--porcelain'])).trim();
  return !dirty;
}

async function maybeStash({ dir, enabled, keep, message }) {
  if (!enabled && !keep) {
    return { stashed: false, kept: false };
  }
  const clean = await isWorktreeClean(dir);
  if (clean) {
    return { stashed: false, kept: false };
  }
  const msg = message || `hstack auto-stash (${new Date().toISOString()})`;
  // Include untracked files (-u). If stash applies cleanly later, we'll pop.
  await git(dir, ['stash', 'push', '-u', '-m', msg]);
  return { stashed: true, kept: Boolean(keep) };
}

async function maybePopStash({ dir, stashed, keep }) {
  if (!stashed || keep) {
    return { popped: false, popError: null };
  }
  try {
    await git(dir, ['stash', 'pop']);
    return { popped: true, popError: null };
  } catch (e) {
    // On conflicts, `git stash pop` keeps the stash entry.
    return { popped: false, popError: String(e?.message ?? e) };
  }
}

async function hardReset({ dir, target }) {
  await git(dir, ['reset', '--hard', target]);
}

async function git(root, args) {
  return await runCapture('git', args, { cwd: root });
}

async function gitOk(root, args) {
  try {
    await runCapture('git', args, { cwd: root });
    return true;
  } catch {
    return false;
  }
}

function parseDepsMode(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'none';
  if (v === 'none') return 'none';
  if (v === 'link' || v === 'symlink') return 'link';
  if (v === 'install') return 'install';
  if (v === 'link-or-install' || v === 'linkorinstall') return 'link-or-install';
  throw new Error(`[wt] invalid --deps value: ${raw}. Expected one of: none | link | install | link-or-install`);
}

async function getWorktreeGitDir(worktreeDir) {
  const gitDir = (await git(worktreeDir, ['rev-parse', '--git-dir'])).trim();
  // rev-parse may return a relative path.
  return isAbsolute(gitDir) ? gitDir : resolve(worktreeDir, gitDir);
}

async function gitShowTopLevel(dir) {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

function getTodayYmd() {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseGitdirFile(contents) {
  const raw = (contents ?? '').toString();
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('gitdir:'));
  const path = line?.slice('gitdir:'.length).trim();
  return path || null;
}

function inferSourceRepoDirFromLinkedGitDir(linkedGitDir) {
  // Typical worktree gitdir: "<repo>/.git/worktrees/<name>"
  // We want "<repo>".
  const worktreesDir = dirname(linkedGitDir);
  const gitDir = dirname(worktreesDir);
  if (basename(worktreesDir) !== 'worktrees' || basename(gitDir) !== '.git') {
    return null;
  }
  return dirname(gitDir);
}

function isJsonMode() {
  return Boolean((process.argv ?? []).includes('--json'));
}

async function runMaybeQuiet(cmd, args, options) {
  if (isJsonMode()) {
    await runCapture(cmd, args, options);
    return;
  }
  await run(cmd, args, options);
}

async function detachGitWorktree({ worktreeDir, expectedBranch = null }) {
  const gitPath = join(worktreeDir, '.git');

  // If `.git` is already a directory, it's already detached.
  if (await pathExists(join(worktreeDir, '.git', 'HEAD'))) {
    const head = (await git(worktreeDir, ['rev-parse', 'HEAD'])).trim();
    let branch = null;
    try {
      const b = (await git(worktreeDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      branch = b || null;
    } catch {
      branch = null;
    }
    // Already detached repos have no "source" repo to prune, and we must not delete the branch here.
    const gitDir = await getWorktreeGitDir(worktreeDir);
    return { worktreeDir, head, branch, sourceRepoDir: null, linkedGitDir: gitDir, alreadyDetached: true };
  }

  const gitFileContents = await readFile(gitPath, 'utf-8');
  const linkedGitDirFromFile = parseGitdirFile(gitFileContents);
  if (!linkedGitDirFromFile) {
    throw new Error(`[wt] expected ${gitPath} to be a linked worktree .git file`);
  }
  const linkedGitDir = isAbsolute(linkedGitDirFromFile) ? linkedGitDirFromFile : resolve(worktreeDir, linkedGitDirFromFile);

  // If the worktree's linked gitdir has been deleted (common after manual moves/prunes),
  // we can still archive it by reconstructing a standalone repo from the source repo.
  const linkedGitDirExists = await pathExists(linkedGitDir);
  const isBrokenLinkedWorktree = !linkedGitDirExists;

  let branch = null;
  let head = '';

  if (!isBrokenLinkedWorktree) {
    head = (await git(worktreeDir, ['rev-parse', 'HEAD'])).trim();
    try {
      const b = (await git(worktreeDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      branch = b || null;
    } catch {
      branch = null;
    }
  } else {
    branch = expectedBranch || null;
  }

  let sourceRepoDir = null;
  if (!isBrokenLinkedWorktree) {
    const commonDir = (await git(worktreeDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    sourceRepoDir = dirname(commonDir);
  } else {
    sourceRepoDir = inferSourceRepoDirFromLinkedGitDir(linkedGitDir);
    if (!sourceRepoDir) {
      throw new Error(`[wt] unable to infer source repo dir from broken linked gitdir: ${linkedGitDir}`);
    }
    if (!head) {
      try {
        if (branch) {
          head = (await runCapture('git', ['rev-parse', branch], { cwd: sourceRepoDir })).trim();
        } else {
          head = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceRepoDir })).trim();
        }
      } catch {
        head = '';
      }
    }
  }

  await rename(gitPath, join(worktreeDir, '.git.worktree'));
  await runMaybeQuiet('git', ['init'], { cwd: worktreeDir });

  const remoteName = 'archive-source';
  if (sourceRepoDir) {
    await runMaybeQuiet('git', ['remote', 'add', remoteName, sourceRepoDir], { cwd: worktreeDir });
    await runMaybeQuiet('git', ['fetch', '--tags', remoteName], { cwd: worktreeDir });
  }

  if (branch) {
    await runMaybeQuiet('git', ['update-ref', `refs/heads/${branch}`, head], { cwd: worktreeDir });
    await runMaybeQuiet('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: worktreeDir });
  } else {
    await writeFile(join(worktreeDir, '.git', 'HEAD'), `${head}\n`, 'utf-8');
  }

  // Preserve staged state by copying the per-worktree index into the new repo.
  if (!isBrokenLinkedWorktree) {
    await copyFile(join(linkedGitDir, 'index'), join(worktreeDir, '.git', 'index')).catch(() => {});
  } else if (head) {
    // Populate the index from HEAD without touching the working tree, so uncommitted changes remain intact.
    await runMaybeQuiet('git', ['read-tree', head], { cwd: worktreeDir }).catch(() => {});
  }
  // Avoid leaving a confusing untracked file behind in the archived repo.
  await rm(join(worktreeDir, '.git.worktree'), { force: true }).catch(() => {});

  return { worktreeDir, head, branch, sourceRepoDir, linkedGitDir, alreadyDetached: false };
}

async function findStacksReferencingWorktree({ rootDir, worktreeDir }) {
  const workspaceDir = getWorkspaceDir(rootDir);
  const wtReal = await realpath(worktreeDir).catch(() => resolve(worktreeDir));
  const stackNames = await listAllStackNames();
  const hits = [];

  for (const name of stackNames) {
    const { envPath } = resolveStackEnvPath(name);
    const contents = await readFile(envPath, 'utf-8').catch(() => '');
    if (!contents) continue;
    const parsed = parseDotenv(contents);
    const keys = [];

    const raw = String(parsed.get(REPO_DIR_ENV_KEY) ?? '').trim();
    if (raw) {
      const abs = isAbsolute(raw) ? raw : resolve(workspaceDir, raw);
      const absReal = await realpath(abs).catch(() => resolve(abs));
      if (absReal === wtReal || absReal.startsWith(wtReal + '/')) {
        keys.push(REPO_DIR_ENV_KEY);
      }
    }

    if (keys.length) {
      hits.push({ name, envPath, keys });
    }
  }

  return hits;
}

async function ensureWorktreeExclude(worktreeDir, patterns) {
  const gitDir = await getWorktreeGitDir(worktreeDir);
  const excludePath = join(gitDir, 'info', 'exclude');
  const existing = (await readFile(excludePath, 'utf-8').catch(() => '')).toString();
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const want = patterns.map((p) => p.trim()).filter(Boolean).filter((p) => !existingLines.has(p));
  if (!want.length) return;
  const next = (existing ? existing.replace(/\s*$/, '') + '\n' : '') + want.join('\n') + '\n';
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, next, 'utf-8');
}

async function detectPackageManager(dir) {
  if (await pathExists(join(dir, 'package.json'))) return { kind: 'yarn' };
  return { kind: null };
}

async function linkNodeModules({ fromDir, toDir }) {
  const src = join(fromDir, 'node_modules');
  const dest = join(toDir, 'node_modules');

  if (!(await pathExists(src))) {
    return { linked: false, reason: `source node_modules missing: ${src}` };
  }
  if (await pathExists(dest)) {
    return { linked: false, reason: `dest node_modules already exists: ${dest}` };
  }

  await symlink(src, dest);
  // Worktrees sometimes treat node_modules symlinks oddly; ensure it's excluded even if .gitignore misses it.
  await ensureWorktreeExclude(toDir, ['node_modules']);
  return { linked: true, reason: null };
}

async function installDependencies({ dir }) {
  const pm = await detectPackageManager(dir);
  if (!pm.kind) {
    return { installed: false, reason: 'no package manager detected (no package.json)' };
  }

  const env = await applyStackCacheEnv(process.env);

  // IMPORTANT:
  // When a caller requests --json, stdout must be reserved for JSON output only.
  // Package managers (especially Yarn) write progress to stdout, which would corrupt JSON parsing
  // in wrappers like `stack pr`.
  const jsonMode = Boolean((process.argv ?? []).includes('--json'));
  const runForJson = async (cmd, args) => {
    try {
      const out = await runCapture(cmd, args, { cwd: dir, env });
      if (out) process.stderr.write(out);
    } catch (e) {
      const out = String(e?.out ?? '');
      const err = String(e?.err ?? '');
      if (out) process.stderr.write(out);
      if (err) process.stderr.write(err);
      throw e;
    }
  };

  // Yarn-only.
  // Works for yarn classic; yarn berry will ignore/translate flags as needed.
  if (jsonMode) {
    await runForJson('yarn', ['install', '--frozen-lockfile']);
  } else {
    await run('yarn', ['install', '--frozen-lockfile'], { cwd: dir, env });
  }
  return { installed: true, reason: null };
}

function allowNodeModulesSymlinkForRepo() {
  // Expo/Metro commonly breaks with symlinked node_modules. Avoid symlinks by default.
  // Override if you *really* want to experiment:
  //   HAPPIER_STACK_WT_ALLOW_NODE_MODULES_SYMLINK=1
  return (process.env.HAPPIER_STACK_WT_ALLOW_NODE_MODULES_SYMLINK ?? '').toString().trim() === '1';
}

async function maybeSetupDeps({ repoRoot, baseDir, worktreeDir, depsMode, component }) {
  if (!depsMode || depsMode === 'none') {
    return { mode: 'none', linked: false, installed: false, message: null };
  }

  // Prefer explicit baseDir if provided, otherwise link from the primary checkout (repoRoot).
  const linkFrom = baseDir || repoRoot;
  const allowSymlink = allowNodeModulesSymlinkForRepo();

  if (depsMode === 'link' || depsMode === 'link-or-install') {
    if (!allowSymlink) {
      const msg =
        `[wt] refusing to symlink node_modules by default (Expo/Metro is often broken by symlinks).\n` +
        `[wt] Fix: use --deps=install (recommended). To override: set HAPPIER_STACK_WT_ALLOW_NODE_MODULES_SYMLINK=1`;
      if (depsMode === 'link') {
        return { mode: depsMode, linked: false, installed: false, message: msg };
      }
      // link-or-install: fall through to install.
    } else {
      const res = await linkNodeModules({ fromDir: linkFrom, toDir: worktreeDir });
      if (res.linked) {
        return { mode: depsMode, linked: true, installed: false, message: null };
      }
      if (depsMode === 'link') {
        return { mode: depsMode, linked: false, installed: false, message: res.reason };
      }
      // fall through to install
    }
  }

  const inst = await installDependencies({ dir: worktreeDir });
  return { mode: depsMode, linked: false, installed: Boolean(inst.installed), message: inst.reason };
}

async function normalizeRemoteName(repoRoot, remoteName) {
  const want = (remoteName ?? '').trim();
  if (!want) return want;

  // Some checkouts use `origin`, others use `fork`. Treat them as interchangeable if one is missing.
  if (await gitOk(repoRoot, ['remote', 'get-url', want])) {
    return want;
  }
  if (want === 'origin' && (await gitOk(repoRoot, ['remote', 'get-url', 'fork']))) {
    return 'fork';
  }
  if (want === 'fork' && (await gitOk(repoRoot, ['remote', 'get-url', 'origin']))) {
    return 'origin';
  }
  return want;
}

function parseWorktreeListPorcelain(out) {
  const blocks = out
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const wt = { path: null, head: null, branchRef: null, detached: false };
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wt.path = line.slice('worktree '.length).trim();
        } else if (line.startsWith('HEAD ')) {
          wt.head = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          wt.branchRef = line.slice('branch '.length).trim();
        } else if (line === 'detached') {
          wt.detached = true;
        }
      }
      if (!wt.path) {
        return null;
      }
      return wt;
    })
    .filter(Boolean);
}

function getComponentRepoRoot(rootDir, component) {
  // Repo-only model: components/services are derived from the active repo checkout.
  return getComponentRepoDir(rootDir, component);
}

async function resolveOwners(repoRoot) {
  const originRemote = await normalizeRemoteName(repoRoot, 'origin') || 'origin';
  const originUrl = (await git(repoRoot, ['remote', 'get-url', originRemote])).trim();
  const upstreamUrl = (await git(repoRoot, ['remote', 'get-url', 'upstream']).catch(() => '')).trim();

  const originOwner = parseGithubOwner(originUrl);
  const upstreamOwner = parseGithubOwner(upstreamUrl);

  if (!originOwner) {
    throw new Error(`[wt] unable to parse origin owner for ${repoRoot} (${originRemote} -> ${originUrl})`);
  }

  return { originOwner, upstreamOwner: upstreamOwner ?? originOwner };
}

async function resolveRemoteOwner(repoRoot, remoteName) {
  const resolvedRemoteName = await normalizeRemoteName(repoRoot, remoteName);
  const remoteUrl = (await git(repoRoot, ['remote', 'get-url', resolvedRemoteName])).trim();
  const owner = parseGithubOwner(remoteUrl);
  if (!owner) {
    throw new Error(`[wt] unable to parse owner for remote '${resolvedRemoteName}' in ${repoRoot} (${remoteUrl})`);
  }
  return { owner, remoteUrl, remoteName: resolvedRemoteName };
}

async function resolveRemoteDefaultBranchName(repoRoot, remoteName, { component } = {}) {
  // Some repos use non-`main` distribution branches on origin. For legacy compatibility, if a
  // branch matching the component name exists on the chosen remote, prefer it. Otherwise fall
  // back to the remote's HEAD branch, then `main`.
  if (component) {
    const ref = `refs/remotes/${remoteName}/${component}`;
    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', ref])) {
      return component;
    }
  }

  const remoteHead = (await git(repoRoot, ['symbolic-ref', '-q', '--short', `refs/remotes/${remoteName}/HEAD`]).catch(() => '')).trim();
  if (remoteHead.startsWith(`${remoteName}/`)) {
    return remoteHead.slice(remoteName.length + 1);
  }

  return 'main';
}

function inferTargetOwner({ branchName, branchRemote, originOwner, upstreamOwner }) {
  const lower = branchName.toLowerCase();
  if (branchName.startsWith(`${originOwner}/`)) {
    return originOwner;
  }
  if (branchName.startsWith(`${upstreamOwner}/`)) {
    return upstreamOwner;
  }

  if (branchRemote === 'upstream' || lower.includes('upstream')) {
    return upstreamOwner;
  }

  return originOwner;
}

function branchRest({ branchName, owner }) {
  return branchName.startsWith(`${owner}/`) ? branchName.slice(owner.length + 1) : branchName;
}

// NOTE: legacy migrate command removed (no compatibility with old multi-repo layouts).

async function cmdUse({ rootDir, args, flags }) {
  const component = args.length >= 2 ? args[0] : DEFAULT_REPO_COMPONENT;
  const spec = args.length >= 2 ? args[1] : args[0];
  if (!spec) {
    throw new Error('[wt] usage: hstack wt use <owner/branch|path|default|main> [--force]');
  }

  void component;

  // Safety: main stack should not be repointed to arbitrary worktrees by default.
  // This is the most common “oops, the main stack now runs my PR checkout” footgun (especially for agents).
  const force = Boolean(flags?.has('--force'));
  if (!force && isMainStack() && spec !== 'default' && spec !== 'main') {
    throw new Error(
      `[wt] refusing to repoint the main stack by default.\n` +
        `- stack: main\n` +
        `- requested: ${spec}\n` +
        `\n` +
        `Recommendation:\n` +
        `- Create a new isolated stack and switch that stack instead:\n` +
        `  hstack stack new exp1 --interactive\n` +
        `  hstack stack wt exp1 -- use ${spec}\n` +
        `\n` +
        `If you really intend to repoint the main stack, re-run with --force:\n` +
        `  hstack wt use ${spec} --force\n`
    );
  }

  const worktreesRoot = getWorktreesRoot(rootDir);
  const envPath = process.env.HAPPIER_STACK_ENV_FILE?.trim() ? process.env.HAPPIER_STACK_ENV_FILE.trim() : null;

  if (spec === 'default' || spec === 'main') {
    const repoDir = getDefaultRepoDir(rootDir);
    const updates = [{ key: REPO_DIR_ENV_KEY, value: repoDir }];
    await (envPath ? ensureEnvFileUpdated({ envPath, updates }) : ensureEnvLocalUpdated({ rootDir, updates }));
    return { activeDir: repoDir, repoDir, mode: 'default' };
  }

  // Resolve the target to a concrete repo directory.
  const resolvedDir = resolveComponentWorktreeDir({ rootDir, component: DEFAULT_REPO_COMPONENT, spec });
  if (!resolvedDir) {
    throw new Error(`[wt] unable to resolve spec: ${spec}`);
  }

  const monoRoot = coerceHappyMonorepoRootFromPath(resolvedDir);
  if (!monoRoot) {
    throw new Error(
      `[wt] invalid target for hstack worktrees:\n` +
        `- expected a path inside the Happier monorepo (contains apps/ui|apps/cli|apps/server)\n` +
        `- but got: ${resolvedDir}\n` +
        `Fix: pick a worktree under ${worktreesRoot}/ or pass an absolute path to a Happier checkout/worktree.`
    );
  }
  const writeDir = monoRoot;

  if (!(await pathExists(writeDir))) {
    throw new Error(`[wt] target does not exist: ${writeDir}`);
  }

  const updates = [{ key: REPO_DIR_ENV_KEY, value: writeDir }];
  await (envPath ? ensureEnvFileUpdated({ envPath, updates }) : ensureEnvLocalUpdated({ rootDir, updates }));

  const activeDir = writeDir;
  return { activeDir, repoDir: writeDir, mode: 'override' };
}

async function cmdUseInteractive({ rootDir }) {
  await withRl(async (rl) => {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Switch active worktree'));

    const specs = await listWorktreeSpecs({ rootDir, component: DEFAULT_REPO_COMPONENT });

    const kindOptions = [{ label: `default (${dim('main checkout')})`, value: 'default' }];
    if (specs.length) {
      kindOptions.push({ label: `pick existing worktree (${green('recommended')})`, value: 'pick' });
    }
    const choice = await promptSelect(rl, {
      title: `${bold('Target')}\n${dim(`Pick which ${cyan('repo')} checkout should become active.`)}`,
      options: kindOptions,
      defaultIndex: 0,
    });
    if (choice === 'pick') {
      const picked = await promptSelect(rl, {
        title: `${bold(`Available ${cyan('repo')} worktrees`)}`,
        options: specs.map((s) => ({ label: s, value: s })),
        defaultIndex: 0,
      });
      await cmdUse({ rootDir, args: [picked], flags: new Set(['--force']) });
      return;
    }
    await cmdUse({ rootDir, args: ['default'], flags: new Set(['--force']) });
  });
}

async function cmdNew({ rootDir, argv }) {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const slug = positionals[2] ? positionals[2] : positionals[1];
  void legacyComponent;

  if (!slug) {
    throw new Error(
      '[wt] usage: hstack wt new <slug> [--from=upstream|origin] [--remote=<name>] [--base=<ref>|--base-worktree=<spec>] [--deps=none|link|install|link-or-install] [--use]'
    );
  }

  const { flags, kv } = parseArgs(argv.slice(1));
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing repo at ${repoRoot}`);
  }

  const remoteOverride = (kv.get('--remote') ?? '').trim();
  const from = (kv.get('--from') ?? '').trim().toLowerCase() || 'upstream';
  let remoteName = remoteOverride || (from === 'origin' ? 'origin' : 'upstream');

  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName);

  const baseOverride = (kv.get('--base') ?? '').trim();
  const baseWorktreeSpec = (kv.get('--base-worktree') ?? kv.get('--from-worktree') ?? '').trim();
  let baseFromWorktree = '';
  let baseWorktreeDir = '';
  if (!baseOverride && baseWorktreeSpec) {
    baseWorktreeDir = resolveComponentWorktreeDir({ rootDir, component, spec: baseWorktreeSpec });
    if (!(await pathExists(baseWorktreeDir))) {
      throw new Error(`[wt] --base-worktree does not exist: ${baseWorktreeDir}`);
    }
    const branch = (await git(baseWorktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch && branch !== 'HEAD') {
      baseFromWorktree = branch;
    } else {
      baseFromWorktree = (await git(baseWorktreeDir, ['rev-parse', 'HEAD'])).trim();
    }
  }

  // Default: base worktrees on a local mirror branch like `slopus/main` (or `happier-dev/happy-server-light`).
  // This scales to multiple upstream remotes without relying on a generic "upstream-main".
  const mirrorBranch = `${owner}/${defaultBranch}`;
  const base = baseOverride || baseFromWorktree || mirrorBranch;
  const branchName = `${owner}/${slug}`;

  const worktreesRoot = getWorktreesRoot(rootDir);
  const repoKey = worktreeRepoKeyForComponent(rootDir, component);
  const destWorktreeRoot = join(worktreesRoot, repoKey, owner, ...slug.split('/'));
  await mkdir(dirname(destWorktreeRoot), { recursive: true });

  // Ensure remotes are present.
  await git(repoRoot, ['fetch', '--all', '--prune', '--quiet']);

  // Keep the mirror branch up to date when using the default base.
  if (!baseOverride && !baseFromWorktree) {
    await git(repoRoot, ['fetch', '--quiet', remoteName, defaultBranch]);
    await git(repoRoot, ['branch', '-f', mirrorBranch, `${remoteName}/${defaultBranch}`]);
    await git(repoRoot, ['branch', '--set-upstream-to', `${remoteName}/${defaultBranch}`, mirrorBranch]).catch(() => {});
  }

  // If the branch already exists (common when migrating between workspaces),
  // attach a new worktree to that branch instead of failing.
  if (await gitOk(repoRoot, ['show-ref', '--verify', `refs/heads/${branchName}`])) {
    await git(repoRoot, ['worktree', 'add', destWorktreeRoot, branchName]);
  } else {
    await git(repoRoot, ['worktree', 'add', '-b', branchName, destWorktreeRoot, base]);
  }

  const depsMode = parseDepsMode(kv.get('--deps'));
  const depsDir = destWorktreeRoot;
  const deps = await maybeSetupDeps({ repoRoot, baseDir: baseWorktreeDir || '', worktreeDir: depsDir, depsMode, component });

  const shouldUse = flags.has('--use');
  const force = flags.has('--force');
  if (shouldUse) {
    // Delegate to cmdUse so monorepo components stay coherent (and so stack-mode writes to the stack env file).
    await cmdUse({ rootDir, args: [destWorktreeRoot], flags });
  }

  return { component, branch: branchName, path: depsDir, base, used: shouldUse, deps, repoKey, worktreeRoot: destWorktreeRoot };
}

async function cmdDuplicate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[3] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const fromSpec = positionals[3] ? positionals[2] : positionals[1];
  const slug = positionals[3] ? positionals[3] : positionals[2];
  void legacyComponent;

  if (!fromSpec || !slug) {
    throw new Error(
      '[wt] usage: hstack wt duplicate <fromWorktreeSpec|path|active|default> <newSlug> [--remote=<name>] [--deps=none|link|install|link-or-install] [--use] [--json]'
    );
  }

  // Prefer inferring the remote from the source spec's owner when possible (owner/<branch...>).
  const remoteOverride = (kv.get('--remote') ?? '').trim();
  let remoteName = remoteOverride;
  if (!remoteName && !isAbsolute(fromSpec)) {
    const owner = String(fromSpec).trim().split('/')[0];
    if (owner && owner !== 'active' && owner !== 'default' && owner !== 'main') {
      const repoRoot = getComponentRepoRoot(rootDir, component);
      remoteName = await normalizeRemoteName(repoRoot, await inferRemoteNameForOwner({ repoDir: repoRoot, owner }));
    }
  }

  const depsMode = (kv.get('--deps') ?? '').trim();
  const forwarded = ['new', component, slug, `--base-worktree=${fromSpec}`];
  if (remoteName) forwarded.push(`--remote=${remoteName}`);
  if (depsMode) forwarded.push(`--deps=${depsMode}`);
  if (flags.has('--use')) forwarded.push('--use');
  if (flags.has('--force')) forwarded.push('--force');
  if (json) forwarded.push('--json');

  // Delegate to cmdNew for the actual implementation (single source of truth).
  return await cmdNew({ rootDir, argv: forwarded });
}

async function cmdPr({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const prInput = positionals[2] ? positionals[2] : positionals[1];
  void legacyComponent;

  if (!prInput) {
    throw new Error(
      '[wt] usage: hstack wt pr <pr-url|number> [--remote=upstream] [--slug=<name>] [--deps=none|link|install|link-or-install] [--use] [--update] [--force] [--json]'
    );
  }

  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing repo at ${repoRoot}`);
  }

  const pr = parseGithubPullRequest(prInput);
  if (!pr?.number || !Number.isFinite(pr.number)) {
    throw new Error(`[wt] unable to parse PR: ${prInput}`);
  }

  const remoteFromArg = (kv.get('--remote') ?? '').trim();
  const canFetchByUrl = !remoteFromArg && pr.owner && pr.repo;
  const fetchTarget = canFetchByUrl ? `https://github.com/${pr.owner}/${pr.repo}.git` : null;

  // If we can fetch directly from the PR URL's repo, do it. This avoids any assumptions about local
  // remote names like "origin" vs "upstream" and works even when the repo doesn't have that remote set up.
  const remoteName = canFetchByUrl ? '' : await normalizeRemoteName(repoRoot, remoteFromArg || 'upstream');
  const { owner } = canFetchByUrl ? { owner: pr.owner } : await resolveRemoteOwner(repoRoot, remoteName);

  const slugExtra = sanitizeSlugPart(kv.get('--slug') ?? '');
  const slug = slugExtra ? `pr/${pr.number}-${slugExtra}` : `pr/${pr.number}`;
  const branchName = `${owner}/${slug}`;

  const worktreesRoot = getWorktreesRoot(rootDir);
  const repoKey = worktreeRepoKeyForComponent(rootDir, component);
  const destWorktreeRoot = join(worktreesRoot, repoKey, owner, ...slug.split('/'));
  await mkdir(dirname(destWorktreeRoot), { recursive: true });

  const exists = await pathExists(destWorktreeRoot);
  const doUpdate = flags.has('--update');
  if (exists && !doUpdate) {
    throw new Error(`[wt] destination already exists: ${destWorktreeRoot}\n[wt] re-run with --update to refresh it`);
  }

  // Fetch PR head ref (GitHub convention). Use + to allow force-updated PR branches when --force is set.
  // In sandbox mode, be more aggressive: the entire workspace is disposable, so it's safe to
  // reset an existing local PR branch to the fetched PR head if needed.
  const force = flags.has('--force') || isSandboxed();
  let oldHead = null;
  const prRef = `refs/pull/${pr.number}/head`;
  if (exists) {
    // Update existing worktree.
    const stash = await maybeStash({
      dir: destWorktreeRoot,
      enabled: flags.has('--stash'),
      keep: flags.has('--stash-keep'),
      message: `[hstack] wt pr ${pr.number}`,
    });
    if (!(await isWorktreeClean(destWorktreeRoot)) && !stash.stashed) {
      throw new Error(`[wt] worktree is not clean (${destWorktreeRoot}). Re-run with --stash to auto-stash changes.`);
    }

    oldHead = (await git(destWorktreeRoot, ['rev-parse', 'HEAD'])).trim();
    await git(repoRoot, ['fetch', '--quiet', fetchTarget ?? remoteName, prRef]);
    const newTip = (await git(repoRoot, ['rev-parse', 'FETCH_HEAD'])).trim();

    const isAncestor = await gitOk(repoRoot, ['merge-base', '--is-ancestor', oldHead, newTip]);
    if (!isAncestor && !force) {
      const hint = fetchTarget
        ? `[wt] re-run with: hstack wt pr ${pr.number} --update --force`
        : `[wt] re-run with: hstack wt pr ${pr.number} --remote=${remoteName} --update --force`;
      throw new Error(
        `[wt] PR update is not a fast-forward (likely force-push) for ${branchName}\n` +
          hint
      );
    }

    // Update working tree to the fetched tip.
    if (isAncestor) {
      await git(destWorktreeRoot, ['merge', '--ff-only', newTip]);
    } else {
      await git(destWorktreeRoot, ['reset', '--hard', newTip]);
    }

    // Only attempt to restore stash if update succeeded without forcing a conflict state.
    const stashPop = await maybePopStash({ dir: destWorktreeRoot, stashed: stash.stashed, keep: stash.kept });
    if (stashPop.popError) {
      if (!force && oldHead) {
        await hardReset({ dir: destWorktreeRoot, target: oldHead });
        throw new Error(
          `[wt] PR updated, but restoring stashed changes conflicted.\n` +
            `[wt] Reverted update to keep your working tree clean.\n` +
            `[wt] Worktree: ${destWorktreeRoot}\n` +
            `[wt] Re-run with --update --stash --force to keep the conflict state for manual resolution.`
        );
      }
      // Keep conflict state in place (or if we can't revert).
      throw new Error(
        `[wt] PR updated, but restoring stashed changes conflicted.\n` +
          `[wt] Worktree: ${destWorktreeRoot}\n` +
          `[wt] Conflicts are left in place for manual resolution (--force).`
      );
    }
  } else {
    await git(repoRoot, ['fetch', '--quiet', fetchTarget ?? remoteName, prRef]);
    const newTip = (await git(repoRoot, ['rev-parse', 'FETCH_HEAD'])).trim();

    const branchExists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    if (branchExists) {
      if (!force) {
        // If the branch already points at the fetched PR tip, we can safely just attach a worktree.
        const branchHead = (await git(repoRoot, ['rev-parse', branchName])).trim();
        if (branchHead !== newTip) {
          throw new Error(`[wt] branch already exists: ${branchName}\n[wt] re-run with --force to reset it to the PR head`);
        }
        await git(repoRoot, ['worktree', 'add', destWorktreeRoot, branchName]);
      } else {
        await git(repoRoot, ['branch', '-f', branchName, newTip]);
        await git(repoRoot, ['worktree', 'add', destWorktreeRoot, branchName]);
      }
    } else {
      // Create worktree at PR head (new local branch).
      await git(repoRoot, ['worktree', 'add', '-b', branchName, destWorktreeRoot, newTip]);
    }
  }

  // Optional deps handling (useful when PR branches add/change dependencies).
  const depsMode = parseDepsMode(kv.get('--deps'));
  const depsDir = destWorktreeRoot;
  const deps = await maybeSetupDeps({ repoRoot, baseDir: repoRoot, worktreeDir: depsDir, depsMode, component });

  const shouldUse = flags.has('--use');
  if (shouldUse) {
    // Reuse cmdUse so it writes to env.local or stack env file depending on context.
    await cmdUse({ rootDir, args: [destWorktreeRoot], flags });
  }

  const newHead = (await git(destWorktreeRoot, ['rev-parse', 'HEAD'])).trim();
  const res = {
    component,
    pr: pr.number,
    remote: remoteName,
    branch: branchName,
    path: depsDir,
    worktreeRoot: destWorktreeRoot,
    repoKey,
    used: shouldUse,
    updated: exists,
    oldHead,
    newHead,
    deps,
  };
  if (json) {
    return res;
  }
  return res;
}

async function cmdStatus({ rootDir, argv }) {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const dirty = (await git(dir, ['status', '--porcelain'])).trim();
  const isClean = !dirty;

  let upstream = null;
  try {
    upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    upstream = null;
  }

  let ahead = null;
  let behind = null;
  if (upstream) {
    try {
      const counts = (await git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim();
      const [left, right] = counts.split(/\s+/g).map((n) => Number(n));
      behind = Number.isFinite(left) ? left : null;
      ahead = Number.isFinite(right) ? right : null;
    } catch {
      ahead = null;
      behind = null;
    }
  }

  const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean);

  return { component, dir, branch, head, upstream, ahead, behind, isClean, conflicts };
}

async function cmdPush({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    throw new Error('[wt] cannot push detached HEAD (checkout a branch first)');
  }

  let remote = (kv.get('--remote') ?? '').trim() || 'origin';
  remote = (await normalizeRemoteName(dir, remote)) || remote;
  const args = ['push', '-u', remote, 'HEAD'];
  if (flags.has('--dry-run')) {
    args.push('--dry-run');
  }
  await git(dir, args);
  return { component, dir, remote, branch, dryRun: flags.has('--dry-run') };
}

async function cmdUpdate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;

  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing repo at ${repoRoot}`);
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const statusBefore = await cmdStatus({ rootDir, argv: ['status', component, dir] });
  if (!statusBefore.isClean && !flags.has('--stash') && !flags.has('--stash-keep')) {
    throw new Error(`[wt] working tree is not clean (${dir}). Re-run with --stash to auto-stash changes.`);
  }

  let remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName);
  const mirrorBranch = `${owner}/${defaultBranch}`;

  const baseOverride = (kv.get('--base') ?? '').trim();
  const base = baseOverride || mirrorBranch;

  // Keep the mirror branch updated when using the default base.
  if (!baseOverride) {
    await cmdSync({ rootDir, argv: ['sync', component, `--remote=${remoteName}`] });
  }

  const mode = flags.has('--merge') ? 'merge' : 'rebase';
  const dryRun = flags.has('--dry-run');
  const force = flags.has('--force');
  const stashRequested = flags.has('--stash') || flags.has('--stash-keep');
  const stashKeep = flags.has('--stash-keep');

  if (dryRun && stashRequested) {
    throw new Error('[wt] --dry-run cannot be combined with --stash/--stash-keep (it would modify your working tree)');
  }

  const conflictFiles = async () => {
    const out = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  };

  const abortMerge = async () => {
    await git(dir, ['merge', '--abort']).catch(() => {});
  };
  const abortRebase = async () => {
    await git(dir, ['rebase', '--abort']).catch(() => {});
  };

  // Dry-run: try a merge and abort to see if it would conflict.
  if (dryRun) {
    const status = await cmdStatus({ rootDir, argv: ['status', component, dir] });
    if (!status.isClean) {
      throw new Error(`[wt] working tree is not clean (${dir}). Commit/stash first.`);
    }
    let ok = true;
    let conflicts = [];
    try {
      await git(dir, ['merge', '--no-commit', '--no-ff', '--no-stat', base]);
      conflicts = await conflictFiles();
      ok = conflicts.length === 0;
    } catch {
      conflicts = await conflictFiles();
      ok = conflicts.length === 0 ? false : false;
    } finally {
      await abortMerge();
    }
    return { component, dir, mode, base, dryRun: true, ok, conflicts };
  }

  // Optionally stash before applying.
  const oldHead = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const stash = await maybeStash({
    dir,
    enabled: flags.has('--stash'),
    keep: stashKeep,
    message: `[hstack] wt update ${component}`,
  });
  if (!(await isWorktreeClean(dir)) && !stash.stashed) {
    throw new Error(`[wt] working tree is not clean (${dir}). Re-run with --stash to auto-stash changes.`);
  }

  // Apply update.
  if (mode === 'merge') {
    try {
      await git(dir, ['merge', '--no-edit', base]);
      const stashPop = await maybePopStash({ dir, stashed: stash.stashed, keep: stash.kept });
      if (stashPop.popError) {
        if (!force) {
          await hardReset({ dir, target: oldHead });
          return {
            component,
            dir,
            mode,
            base,
            ok: false,
            conflicts: [],
            error: 'stash-pop-conflict',
            message:
              `[wt] update succeeded, but restoring stashed changes conflicted.\n` +
              `[wt] Reverted update. Worktree: ${dir}\n` +
              `[wt] Re-run with --stash --force to keep the conflict state for manual resolution.`,
            stash,
            stashPop,
          };
        }
        return {
          component,
          dir,
          mode,
          base,
          ok: false,
          conflicts: await conflictFiles(),
          forceApplied: true,
          error: 'stash-pop-conflict',
          message: `[wt] update succeeded, but restoring stashed changes conflicted (kept for manual resolution). Worktree: ${dir}`,
          stash,
          stashPop,
        };
      }
      return { component, dir, mode, base, ok: true, conflicts: [], stash, stashPop };
    } catch {
      const conflicts = await conflictFiles();
      if (!force) {
        await abortMerge();
      }
      return { component, dir, mode, base, ok: false, conflicts, forceApplied: force, stash, stashPop: { popped: false } };
    }
  }

  // Default: rebase (preferred for clean PR branches).
  try {
    await git(dir, ['rebase', base]);
    const stashPop = await maybePopStash({ dir, stashed: stash.stashed, keep: stash.kept });
    if (stashPop.popError) {
      if (!force) {
        await hardReset({ dir, target: oldHead });
        return {
          component,
          dir,
          mode,
          base,
          ok: false,
          conflicts: [],
          error: 'stash-pop-conflict',
          message:
            `[wt] update succeeded, but restoring stashed changes conflicted.\n` +
            `[wt] Reverted update. Worktree: ${dir}\n` +
            `[wt] Re-run with --stash --force to keep the conflict state for manual resolution.`,
          stash,
          stashPop,
        };
      }
      return {
        component,
        dir,
        mode,
        base,
        ok: false,
        conflicts: await conflictFiles(),
        forceApplied: true,
        error: 'stash-pop-conflict',
        message: `[wt] update succeeded, but restoring stashed changes conflicted (kept for manual resolution). Worktree: ${dir}`,
        stash,
        stashPop,
      };
    }
    return { component, dir, mode, base, ok: true, conflicts: [], stash, stashPop };
  } catch {
    const conflicts = await conflictFiles();
    if (!force) {
      await abortRebase();
    }
    return { component, dir, mode, base, ok: false, conflicts, forceApplied: force, stash, stashPop: { popped: false } };
  }
}

function splitDoubleDash(argv) {
  const idx = argv.indexOf('--');
  if (idx < 0) {
    return { before: argv, after: [] };
  }
  return { before: argv.slice(0, idx), after: argv.slice(idx + 1) };
}

async function cmdGit({ rootDir, argv }) {
  const { before, after } = splitDoubleDash(argv);
  const { flags, kv } = parseArgs(before);
  const json = wantsJson(before, { flags });

  const positionals = before.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;
  if (!after.length) {
    throw new Error('[wt] git requires args after `--` (example: hstack wt git main -- status)');
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const remote = (kv.get('--remote') ?? '').trim();
  // Convenience: allow `--remote=<name>` to imply `git fetch <name> ...` etc by user choice.
  const args = [...after];
  if (remote && (args[0] === 'fetch' || args[0] === 'pull' || args[0] === 'push') && !args.includes(remote)) {
    // leave untouched; user should pass remote explicitly for correctness
  }

  if (json) {
    const stdout = await git(dir, args);
    return { component, dir, args, stdout };
  }

  await run('git', args, { cwd: dir });
  return { component, dir, args };
}

async function cmdSync({ rootDir, argv }) {
  void argv;
  const { kv } = parseArgs(argv);
  const component = DEFAULT_REPO_COMPONENT;
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing repo at ${repoRoot}`);
  }

  let remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName);

  await git(repoRoot, ['fetch', '--quiet', remoteName, defaultBranch]);

  const mirrorBranch = `${owner}/${defaultBranch}`;
  await git(repoRoot, ['branch', '-f', mirrorBranch, `${remoteName}/${defaultBranch}`]);
  // Best-effort: set upstream (works even if already set).
  await git(repoRoot, ['branch', '--set-upstream-to', `${remoteName}/${defaultBranch}`, mirrorBranch]).catch(() => {});

  return { component, remote: remoteName, mirrorBranch, upstreamRef: `${remoteName}/${defaultBranch}` };
}

async function fileExists(path) {
  try {
    return await pathExists(path);
  } catch {
    return false;
  }
}

async function pickBestShell({ kv, prefer = null } = {}) {
  const fromFlag = (kv?.get('--shell') ?? '').trim();
  const fromEnv = (process.env.HAPPIER_STACK_WT_SHELL ?? '').trim();
  const fromShellEnv = (process.env.SHELL ?? '').trim();
  const want = (fromFlag || fromEnv || prefer || fromShellEnv).trim();
  if (want) {
    return want;
  }

  const candidates =
    process.platform === 'win32'
      ? []
      : ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'];
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(c)) {
      return c;
    }
  }
  return process.env.SHELL || '/bin/sh';
}

function escapeForShellDoubleQuotes(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function openTerminalAuto({ dir, shell }) {
  const termPref = (process.env.HAPPIER_STACK_WT_TERMINAL ?? '').trim().toLowerCase();
  const order = termPref ? [termPref] : ['ghostty', 'iterm', 'terminal', 'current'];

  for (const t of order) {
    if (t === 'current') {
      return { kind: 'current' };
    }

    if (t === 'ghostty') {
      if (await commandExists('ghostty')) {
        try {
          // Best-effort. Ghostty supports --working-directory on recent builds.
          await run('ghostty', ['--working-directory', dir], { cwd: dir, env: process.env, stdio: 'inherit' });
          return { kind: 'ghostty' };
        } catch {
          // fall through
        }
      }
    }

    if (t === 'iterm') {
      if (process.platform === 'darwin') {
        try {
          const cmd = `cd "${escapeForShellDoubleQuotes(dir)}"; exec "${escapeForShellDoubleQuotes(shell)}" -i`;
          // Create a new iTerm window and cd into the directory.
          await run('osascript', [
            '-e',
            'tell application "iTerm" to activate',
            '-e',
            'tell application "iTerm" to create window with default profile',
            '-e',
            `tell application "iTerm" to tell current session of current window to write text "${cmd}"`,
          ]);
          return { kind: 'iterm' };
        } catch {
          // fall through
        }
      }
    }

    if (t === 'terminal') {
      if (process.platform === 'darwin') {
        try {
          // Terminal.app: `open -a Terminal <dir>` opens a window in that dir.
          await run('open', ['-a', 'Terminal', dir], { cwd: dir, env: process.env, stdio: 'inherit' });
          return { kind: 'terminal' };
        } catch {
          // fall through
        }
      }
    }
  }

  return { kind: 'current' };
}

function resolveMonorepoEditorDir({ dir, preferPackageDir = false }) {
  if (preferPackageDir) return dir;
  return coerceHappyMonorepoRootFromPath(dir) || dir;
}

async function cmdShell({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;
  const packageDir = resolveComponentWorktreeDir({ rootDir, component, spec });
  const dir = resolveMonorepoEditorDir({ dir: packageDir, preferPackageDir: flags.has('--package') });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const shell = await pickBestShell({ kv });
  const args = ['-i'];
  const terminalFlag = (kv.get('--terminal') ?? '').trim().toLowerCase();
  const newWindow = flags.has('--new-window');
  const wantTerminal = terminalFlag || (newWindow ? 'auto' : 'current');

  if (json) {
    return { component, dir, shell, args, terminal: wantTerminal };
  }

  // This launches a new interactive shell with cwd=dir. It can't change the parent shell, but this is a "real" cd.
  if (wantTerminal === 'current') {
    await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
    return { component, dir, shell, args, terminal: 'current' };
  }

  if (wantTerminal === 'auto') {
    const chosen = await openTerminalAuto({ dir, shell });
    if (chosen.kind === 'current') {
      await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
    }
    return { component, dir, shell, args, terminal: chosen.kind };
  }

  // Explicit terminal selection (best-effort).
  process.env.HAPPIER_STACK_WT_TERMINAL = wantTerminal;
  const chosen = await openTerminalAuto({ dir, shell });
  if (chosen.kind === 'current') {
    await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
  }
  return { component, dir, shell, args, terminal: chosen.kind };
}

async function cmdCode({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;
  const packageDir = resolveComponentWorktreeDir({ rootDir, component, spec });
  const dir = resolveMonorepoEditorDir({ dir: packageDir, preferPackageDir: flags.has('--package') });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }
  const codePath = await resolveCommandPath('code', { cwd: rootDir, env: process.env });
  if (!codePath) {
    throw new Error("[wt] VS Code CLI 'code' not found on PATH. In VS Code: Cmd+Shift+P → 'Shell Command: Install code command in PATH'.");
  }
  if (json) {
    return { component, dir, cmd: 'code', resolvedCmd: codePath };
  }
  await run(codePath, [dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
  return { component, dir, cmd: 'code', resolvedCmd: codePath };
}

async function cmdCursor({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? positionals[1] : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = positionals[2] ? positionals[2] : (positionals[1] ?? '');
  void legacyComponent;
  const packageDir = resolveComponentWorktreeDir({ rootDir, component, spec });
  const dir = resolveMonorepoEditorDir({ dir: packageDir, preferPackageDir: flags.has('--package') });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const cursorPath = await resolveCommandPath('cursor', { cwd: rootDir, env: process.env });
  const hasCursorCli = Boolean(cursorPath);
  if (json) {
    return {
      component,
      dir,
      cmd: hasCursorCli ? 'cursor' : process.platform === 'darwin' ? 'open -a Cursor' : null,
      resolvedCmd: cursorPath || null,
    };
  }

  if (hasCursorCli) {
    await run(cursorPath, [dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return { component, dir, cmd: 'cursor', resolvedCmd: cursorPath };
  }

  if (process.platform === 'darwin') {
    await run('open', ['-a', 'Cursor', dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return { component, dir, cmd: 'open -a Cursor' };
  }

  throw new Error("[wt] Cursor CLI 'cursor' not found on PATH (and non-macOS fallback is unavailable).");
}

async function cmdSyncAll({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const remote = (kv.get('--remote') ?? '').trim();

  const component = DEFAULT_REPO_COMPONENT;
  const results = [];
  try {
    const res = await cmdSync({
      rootDir,
      argv: remote ? ['sync', component, `--remote=${remote}`] : ['sync', component],
    });
    results.push({ component, ok: true, skipped: false, ...res });
  } catch (e) {
    results.push({ component, ok: false, skipped: false, error: String(e?.message ?? e) });
  }

  const ok = results.every((r) => r.ok);
  if (json) return { ok, results };

  const lines = ['[wt] sync-all:'];
  for (const r of results) {
    if (r.ok) {
      lines.push(`- ✅ ${r.component}: ${r.mirrorBranch} -> ${r.upstreamRef}`);
    } else {
      lines.push(`- ❌ ${r.component}: ${r.error}`);
    }
  }
  return { ok, results, text: lines.join('\n') };
}

async function listRepoWorktreePaths({ rootDir }) {
  const repoRoot = getDefaultRepoDir(rootDir);
  if (!(await pathExists(repoRoot))) {
    return [];
  }
  const out = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const wts = parseWorktreeListPorcelain(out);
  return wts.map((w) => w.path).filter(Boolean);
}

async function cmdUpdateAll({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  void argv;
  const json = wantsJson(argv, { flags });

  const remote = (kv.get('--remote') ?? '').trim();
  const base = (kv.get('--base') ?? '').trim();
  const mode = flags.has('--merge') ? 'merge' : 'rebase';
  const dryRun = flags.has('--dry-run');
  const force = flags.has('--force');
  const stash = flags.has('--stash');
  const stashKeep = flags.has('--stash-keep');

  const component = DEFAULT_REPO_COMPONENT;
  const results = [];
  const repoRoot = getDefaultRepoDir(rootDir);
  const paths = await listRepoWorktreePaths({ rootDir });
  for (const dir of paths) {
    if (resolve(dir) === resolve(repoRoot)) {
      // Keep the default checkout stable; update-all is intended for worktrees.
      continue;
    }
    try {
      const args = ['update', dir];
      if (remote) args.push(`--remote=${remote}`);
      if (base) args.push(`--base=${base}`);
      if (mode === 'merge') args.push('--merge');
      if (dryRun) args.push('--dry-run');
      if (stash) args.push('--stash');
      if (stashKeep) args.push('--stash-keep');
      if (force) args.push('--force');
      const res = await cmdUpdate({ rootDir, argv: args });
      results.push({ component, dir, ...res });
    } catch (e) {
      results.push({ component, dir, ok: false, error: String(e?.message ?? e) });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    return { ok, mode, dryRun, force, base: base || '(mirror)', remote: remote || '(default)', results };
  }

  const lines = [
    `[wt] update-all (${mode}${dryRun ? ', dry-run' : ''}${force ? ', force' : ''})`,
    base ? `- base: ${base}` : '- base: <mirror owner/<default-branch>>',
    remote ? `- remote: ${remote}` : '- remote: upstream',
  ];
  for (const r of results) {
    if (r.ok) {
      lines.push(`- ✅ ${r.component}: ${r.dir}`);
    } else if (r.conflicts?.length) {
      lines.push(`- ⚠️  ${r.component}: conflicts (${r.dir})`);
      for (const f of r.conflicts) lines.push(`  - ${f}`);
    } else {
      lines.push(`- ❌ ${r.component}: ${r.error} (${r.dir})`);
    }
  }
  return { ok, results, text: lines.join('\n') };
}

async function cmdNewInteractive({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  await withRl(async (rl) => {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Create a worktree'));
    // eslint-disable-next-line no-console
    console.log(dim('Recommended: base worktrees on upstream to keep PR history clean.'));

    const slug = await prompt(rl, `${dim('Branch slug')} (example: pr/my-feature): `, { defaultValue: '' });
    if (!slug) {
      throw new Error('[wt] slug is required');
    }

    // Default remote is upstream; allow override.
    const remote = await prompt(rl, `${dim('Remote name')} (default: upstream): `, { defaultValue: 'upstream' });

    const args = ['new', slug, `--remote=${remote}`];
    if (kv.get('--base')?.trim()) {
      args.push(`--base=${kv.get('--base').trim()}`);
    }
    if (flags.has('--use')) {
      args.push('--use');
    }
    await cmdNew({ rootDir, argv: args });
  });
}

async function cmdList({ rootDir, args, flags }) {
  const wantsAll = flags?.has('--all') || flags?.has('--all-worktrees');
  const activeOnly = !wantsAll && (flags?.has('--active') || flags?.has('--active-only'));
  void args;

  const dir = getWorktreesRoot(rootDir);
  const activeDir = getActiveRepoDir(rootDir);

  if (activeOnly) {
    return { activeDir, worktrees: [] };
  }

  if (!(await pathExists(dir))) {
    return { activeDir, worktrees: [] };
  }

  const worktrees = [];
  const walk = async (d) => {
    // In git worktrees, ".git" is usually a file that points to the shared git dir.
    // If this is a worktree root, record it and do not descend into it (avoids traversing huge trees like node_modules).
    if (await pathExists(join(d, '.git'))) {
      worktrees.push(d);
      return;
    }
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') continue;
      if (e.name.startsWith('.')) continue;
      await walk(join(d, e.name));
    }
  };
  await walk(dir);
  worktrees.sort();

  return { activeDir, worktrees };
}

async function cmdArchive({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const dryRun = flags.has('--dry-run');
  const deleteBranch = !flags.has('--no-delete-branch');
  const detachStacks = flags.has('--detach-stacks');

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const legacyComponent = positionals[2] ? String(positionals[1] ?? '').trim() : '';
  const component = DEFAULT_REPO_COMPONENT;
  const spec = String(positionals[2] ? positionals[2] : positionals[1] ?? '').trim();
  void legacyComponent;
  if (!spec) {
    throw new Error(
      '[wt] usage: hstack wt archive <worktreeSpec|path|active|default|main> [--dry-run] [--date=YYYY-MM-DD] [--no-delete-branch] [--detach-stacks] [--json]'
    );
  }

  const resolved = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!resolved) {
    throw new Error(`[wt] unable to resolve worktree: ${spec}`);
  }

  let worktreeDir = resolved;
  try {
    worktreeDir = await gitShowTopLevel(resolved);
  } catch {
    // Broken worktrees can have a missing linked gitdir; fall back to the resolved directory.
    worktreeDir = resolved;
  }
  const worktreesRoot = resolve(getWorktreesRoot(rootDir));
  const worktreesRootReal = await realpath(worktreesRoot).catch(() => worktreesRoot);
  const worktreeDirReal = await realpath(worktreeDir).catch(() => worktreeDir);
  const rel = relative(worktreesRootReal, worktreeDirReal);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`[wt] refusing to archive non-worktree path (expected under ${worktreesRoot}): ${worktreeDir}`);
  }

  const date = (kv.get('--date') ?? '').toString().trim() || getTodayYmd();
  const archiveRoot = join(dirname(worktreesRoot), '.worktrees-archive', date);
  const destDir = join(archiveRoot, rel);

  const expectedBranch = rel || null;
  let head = '';
  let branch = null;
  try {
    head = (await git(worktreeDir, ['rev-parse', 'HEAD'])).trim();
    try {
      const b = (await git(worktreeDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      branch = b || null;
    } catch {
      branch = null;
    }
  } catch {
    // For broken linked worktrees, fall back to the branch implied by the worktree path.
    branch = expectedBranch;
    try {
      const gitFileContents = await readFile(join(worktreeDir, '.git'), 'utf-8');
      const linkedGitDirFromFile = parseGitdirFile(gitFileContents);
      if (linkedGitDirFromFile) {
        const linkedGitDir = isAbsolute(linkedGitDirFromFile) ? linkedGitDirFromFile : resolve(worktreeDir, linkedGitDirFromFile);
        const sourceRepoDir = inferSourceRepoDirFromLinkedGitDir(linkedGitDir);
        if (sourceRepoDir && branch) {
          head = (await runCapture('git', ['rev-parse', branch], { cwd: sourceRepoDir })).trim();
        }
      }
    } catch {
      head = '';
    }
  }

  const workspaceDir = getWorkspaceDir(rootDir);
  const sourcePath = relative(workspaceDir, worktreeDir);

  const linkedStacks = await findStacksReferencingWorktree({ rootDir, worktreeDir });
  if (dryRun) {
    return { ok: true, dryRun: true, component, worktreeDir, destDir, head, branch, deleteBranch, detachStacks, linkedStacks };
  }

  let shouldDetachStacks = detachStacks;
  if (linkedStacks.length && !shouldDetachStacks) {
    const names = linkedStacks.map((s) => s.name).join(', ');
    if (!isTty() || isJsonMode()) {
      throw new Error(`[wt] refusing to archive worktree still referenced by stack(s): ${names}. Re-run with --detach-stacks.`);
    }
    const action = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: `${bold('Worktree is still referenced')}\n${dim(`This worktree is pinned by stack(s): ${cyan(names)}`)}`,
        options: [
          { label: `abort (${green('recommended')})`, value: 'abort' },
          { label: `detach those stacks from this worktree`, value: 'detach' },
          { label: `archive the linked stacks (also archives this worktree)`, value: 'archive-stacks' },
        ],
        defaultIndex: 0,
      });
    });

    if (action === 'abort') {
      throw new Error('[wt] archive aborted');
    }
    if (action === 'archive-stacks') {
      for (const s of linkedStacks) {
        // eslint-disable-next-line no-await-in-loop
        await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'archive', s.name, `--date=${date}`], { cwd: rootDir, env: process.env });
      }
      return {
        ok: true,
        dryRun: false,
        component,
        worktreeDir,
        destDir,
        head,
        branch,
        deleteBranch,
        detachStacks: false,
        linkedStacks,
        archivedVia: 'stack-archive',
      };
    }
    shouldDetachStacks = true;
  }

  for (const s of linkedStacks) {
    if (!shouldDetachStacks) break;
    // eslint-disable-next-line no-await-in-loop
    await ensureEnvFilePruned({ envPath: s.envPath, removeKeys: s.keys });
  }

  const detached = await detachGitWorktree({ worktreeDir, expectedBranch: expectedBranch ?? branch ?? null });

  await mkdir(dirname(destDir), { recursive: true });
  await rename(worktreeDir, destDir);

  const meta = [
    `archivedAt=${new Date().toISOString()}`,
    `component=${component}`,
    `ref=${rel}`,
    `sourcePath=${sourcePath}`,
    `head=${detached.head || head}`,
    '',
  ].join('\n');
  await writeFile(join(destDir, 'ARCHIVE_META.txt'), meta, 'utf-8');

  // Remove the stale worktree registry entry (its path is now gone).
  if (detached.sourceRepoDir && !detached.alreadyDetached) {
    await runMaybeQuiet('git', ['worktree', 'prune'], { cwd: detached.sourceRepoDir });
  }

  if (deleteBranch && detached.branch && detached.sourceRepoDir && !detached.alreadyDetached) {
    const worktreesRaw = await runCapture('git', ['worktree', 'list', '--porcelain'], { cwd: detached.sourceRepoDir });
    const inUse = worktreesRaw.includes(`branch refs/heads/${detached.branch}`);
    if (inUse) {
      throw new Error(`[wt] refusing to delete branch still checked out by a worktree: ${detached.branch}`);
    }
    await runMaybeQuiet('git', ['branch', '-D', detached.branch], { cwd: detached.sourceRepoDir });
  }

  return {
    ok: true,
    dryRun: false,
    component,
    worktreeDir,
    destDir,
    head: detached.head || head,
    branch: detached.branch,
    deleteBranch,
    detachStacks,
    linkedStacks,
  };
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] ?? 'help';
  const interactive = argv.includes('--interactive') || argv.includes('-i');
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: ['sync', 'sync-all', 'list', 'new', 'pr', 'use', 'status', 'update', 'update-all', 'push', 'git', 'shell', 'code', 'cursor', 'archive'],
        interactive: ['new', 'use'],
      },
      text: [
        '[wt] usage:',
        '  hstack wt sync [--remote=<name>] [--json]',
        '  hstack wt sync-all [--remote=<name>] [--json]',
        '  hstack wt list [--active|--all] [--json]',
        '  hstack wt new <slug> [--from=upstream|origin] [--remote=<name>] [--base=<ref>|--base-worktree=<spec>] [--deps=none|link|install|link-or-install] [--use] [--force] [--interactive|-i] [--json]',
        '  hstack wt duplicate <fromWorktreeSpec|path|active|default> <newSlug> [--remote=<name>] [--deps=none|link|install|link-or-install] [--use] [--json]',
        '  hstack wt pr <pr-url|number> [--remote=upstream] [--slug=<name>] [--deps=none|link|install|link-or-install] [--use] [--update] [--stash|--stash-keep] [--force] [--json]',
        '  hstack wt use <owner/branch|path|default|main> [--force] [--interactive|-i] [--json]',
        '  hstack wt status [worktreeSpec|default|path] [--json]',
        '  hstack wt update [worktreeSpec|default|path] [--remote=upstream] [--base=<ref>] [--rebase|--merge] [--dry-run] [--stash|--stash-keep] [--force] [--json]',
        '  hstack wt update-all [--remote=upstream] [--base=<ref>] [--rebase|--merge] [--dry-run] [--stash|--stash-keep] [--force] [--json]',
        '  hstack wt push [worktreeSpec|default|path] [--remote=origin] [--dry-run] [--json]',
        '  hstack wt git [worktreeSpec|active|default|main|path] -- <git args...> [--json]',
        '  hstack wt shell [worktreeSpec|active|default|main|path] [--shell=/bin/zsh] [--json]',
        '  hstack wt code [worktreeSpec|active|default|main|path] [--json]',
        '  hstack wt cursor [worktreeSpec|active|default|main|path] [--json]',
        '  hstack wt archive <worktreeSpec|active|default|main|path> [--dry-run] [--date=YYYY-MM-DD] [--no-delete-branch] [--detach-stacks] [--json]',
        '',
        'selectors:',
        '  (omitted) or "active": current active checkout (env override if set; else <workspace>/happier)',
        '  "default" or "main": default checkout (typically under <workspace>/happier)',
        '  "<owner>/<branch...>": <workspace>/.worktrees/<owner>/<branch...>',
        '  "<absolute path>": explicit checkout path',
        '',
        'note:',
        '- Worktrees are repo-scoped (monorepo-only). Component selection is intentionally removed.',
      ].join('\n'),
    });
    return;
  }

  const commandsNeedingComponent = new Set([
    'sync',
    'list',
    'new',
    'duplicate',
    'pr',
    'use',
    'status',
    'update',
    'update-all',
    'push',
    'git',
    'shell',
    'code',
    'cursor',
    'archive',
  ]);
  const legacyComponents = new Set(['happy', 'happy-cli', 'happy-server-light', 'happy-server']);
  const effectiveArgv = (() => {
    if (!commandsNeedingComponent.has(cmd)) return argv;
    const pos = argv.filter((a) => !a.startsWith('--'));
    const maybeComponent = (pos[1] ?? '').trim();
    if (legacyComponents.has(maybeComponent)) return argv;
    // Insert the default component right after the command; legacy command handlers keep working.
    const idx = argv.indexOf(cmd);
    if (idx === -1) return argv;
    const next = argv.slice();
    next.splice(idx + 1, 0, DEFAULT_REPO_COMPONENT);
    return next;
  })();
  const effectivePositionals = effectiveArgv.filter((a) => !a.startsWith('--'));

  if (cmd === 'use') {
    if (interactive && isTty()) {
      await cmdUseInteractive({ rootDir });
    } else {
      const res = await cmdUse({ rootDir, args: effectivePositionals.slice(1), flags });
      printResult({ json, data: res, text: `[wt] active dir -> ${res.activeDir}` });
    }
    return;
  }
  if (cmd === 'new') {
    if (interactive && isTty()) {
      await cmdNewInteractive({ rootDir, argv: effectiveArgv.slice(1) });
    } else {
      const res = await cmdNew({ rootDir, argv: effectiveArgv });
      printResult({
        json,
        data: res,
        text: `[wt] created worktree: ${res.path} (${res.branch} based on ${res.base})`,
      });
    }
    return;
  }
  if (cmd === 'duplicate') {
    const res = await cmdDuplicate({ rootDir, argv: effectiveArgv });
    printResult({
      json,
      data: res,
      text: `[wt] duplicated worktree: ${res.path} (${res.branch} based on ${res.base})`,
    });
    return;
  }
  if (cmd === 'pr') {
    const res = await cmdPr({ rootDir, argv: effectiveArgv });
    printResult({
      json,
      data: res,
      text: `[wt] created PR worktree: ${res.path} (${res.branch})`,
    });
    return;
  }
  if (cmd === 'sync') {
    const res = await cmdSync({ rootDir, argv: effectiveArgv });
    printResult({ json, data: res, text: `[wt] synced ${res.mirrorBranch} -> ${res.upstreamRef}` });
    return;
  }
  if (cmd === 'sync-all') {
    const res = await cmdSyncAll({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    } else {
      printResult({ json: false, text: res.text });
    }
    return;
  }
  if (cmd === 'status') {
    const res = await cmdStatus({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    } else {
      const lines = [
        `[wt] ${res.dir}`,
        `- branch: ${res.branch}`,
        `- upstream: ${res.upstream ?? '(none)'}`,
        `- ahead/behind: ${res.ahead ?? '?'} / ${res.behind ?? '?'}`,
        `- clean: ${res.isClean ? 'yes' : 'no'}`,
        `- conflicts: ${res.conflicts.length ? res.conflicts.join(', ') : '(none)'}`,
      ];
      printResult({ json: false, text: lines.join('\n') });
    }
    return;
  }
  if (cmd === 'update') {
    const res = await cmdUpdate({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    } else if (res.ok) {
      printResult({ json: false, text: `[wt] updated (${res.mode}) from ${res.base}` });
    } else {
      if (res.message) {
        printResult({ json: false, text: res.message });
        return;
      }
      const text =
        `[wt] update had conflicts (${res.mode}) from ${res.base}\n` +
        `worktree: ${res.dir}\n` +
        `conflicts:\n` +
        (res.conflicts.length ? res.conflicts.map((f) => `- ${f}`).join('\n') : '- (unknown)') +
        `\n` +
        (res.forceApplied
          ? '[wt] conflicts left in place for manual resolution (--force)'
          : '[wt] update aborted; re-run with --force to keep conflict state for manual resolution');
      printResult({ json: false, text });
    }
    return;
  }
  if (cmd === 'update-all') {
    const res = await cmdUpdateAll({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    } else {
      printResult({ json: false, text: res.text });
    }
    return;
  }
  if (cmd === 'push') {
    const res = await cmdPush({ rootDir, argv: effectiveArgv });
    printResult({
      json,
      data: res,
      text: res.dryRun
        ? `[wt] would push ${res.branch} -> ${res.remote} (dry-run)`
        : `[wt] pushed ${res.branch} -> ${res.remote}`,
    });
    return;
  }
  if (cmd === 'git') {
    const res = await cmdGit({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'shell') {
    const res = await cmdShell({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'code') {
    const res = await cmdCode({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'cursor') {
    const res = await cmdCursor({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'list') {
    const res = await cmdList({ rootDir, args: effectivePositionals.slice(1), flags });
    if (json) {
      printResult({ json, data: res });
    } else {
      const results = Array.isArray(res?.results) ? res.results : [res];
      const lines = [];
      for (const r of results) {
        lines.push('[wt] worktrees:');
        lines.push(`- active: ${r.activeDir}`);
        for (const p of r.worktrees) {
          lines.push(`- ${p}`);
        }
        lines.push('');
      }
      printResult({ json: false, text: lines.join('\n') });
    }
    return;
  }
  if (cmd === 'archive') {
    const res = await cmdArchive({ rootDir, argv: effectiveArgv });
    if (json) {
      printResult({ json, data: res });
    } else if (res.dryRun) {
      printResult({ json: false, text: `[wt] would archive ${res.worktreeDir} -> ${res.destDir} (dry-run)` });
    } else {
      printResult({ json: false, text: `[wt] archived: ${res.destDir}` });
    }
    return;
  }
  throw new Error(`[wt] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[wt] failed:', err);
  process.exit(1);
});
