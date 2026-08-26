import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { getManagedLimaStatus, startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { publishManagedLimaLocalSshConfig } from '../managed_lima/ssh_publication.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import {
  ensureDevTargetSyncProject,
  flushDevTargetSync,
  pauseOwnedDevTargetSyncProject,
  resumeDevTargetSync,
} from '../dev_targets/sync_project.mjs';
import { inspectDevTargetSync, runDevTargetDependencyBootstrap } from '../dev_targets/executor.mjs';

const CANDIDATE_SYNC_OWNER = 'execution-host-candidate';

function candidateSyncOwner(workspaceId = '') {
  return workspaceId ? `${CANDIDATE_SYNC_OWNER}-${workspaceId}` : CANDIDATE_SYNC_OWNER;
}

function requireSuccess(result, description) {
  if (result?.exitCode === 0 || result?.code === 0) return result;
  const detail = String(result?.err ?? '').trim();
  throw new Error(`[execution-host] ${description} failed${detail ? `: ${detail}` : ''}`);
}

function parseRefs(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('\t');
      if (separator <= 0) throw new Error('[execution-host] Git returned an invalid ref inventory');
      return { name: line.slice(0, separator), object: line.slice(separator + 1) };
    });
}

function refsDigest(refs) {
  const hash = createHash('sha256');
  for (const ref of refs) hash.update(`${ref.object}\t${ref.name}\n`);
  return hash.digest('hex');
}

function projectCandidateCapture(capture) {
  const {
    refs = [],
    worktreeHeads = [],
    ...bounded
  } = capture ?? {};
  return {
    ...bounded,
    refCount: capture?.refCount ?? refs.length,
    refsDigest: capture?.refsDigest ?? refsDigest(refs),
    worktreeHeadCount: capture?.worktreeHeadCount ?? worktreeHeads.length,
  };
}

async function defaultCaptureGitBasis({ sourceDir }) {
  const git = async (args) => requireSuccess(
    await runCaptureResult('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: sourceDir }),
    `Git ${args[0]}`,
  );
  const repositoryRoot = String((await git(['rev-parse', '--show-toplevel'])).out ?? '').trim();
  if (resolve(repositoryRoot) !== resolve(sourceDir)) {
    throw new Error(`[execution-host] source directory must be the Git worktree root: ${repositoryRoot}`);
  }
  const head = String((await git(['rev-parse', 'HEAD'])).out ?? '').trim();
  const headRefResult = await runCaptureResult(
    'git',
    ['-c', 'core.fsmonitor=false', 'symbolic-ref', '-q', 'HEAD'],
    { cwd: sourceDir },
  );
  if (headRefResult.exitCode !== 0) {
    throw new Error('[execution-host] detached HEAD candidate capture is not supported yet');
  }
  const headRef = String(headRefResult.out ?? '').trim();
  const refs = parseRefs((await git([
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname)%09%(objectname)',
  ])).out);
  const status = String((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).out ?? '');
  const worktrees = String((await git(['worktree', 'list', '--porcelain'])).out ?? '');
  const worktreeHeads = [
    ...new Set(
      worktrees
        .split(/\r?\n/)
        .filter((line) => /^HEAD [0-9a-f]{40,64}$/.test(line))
        .map((line) => line.slice('HEAD '.length)),
    ),
  ];
  const commonDirRaw = String((await git(['rev-parse', '--git-common-dir'])).out ?? '').trim();
  const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(sourceDir, commonDirRaw);
  const stackId = String(await readFile(join(commonDir, 'happier-stack-stackless-id'), 'utf8').catch(() => '')).trim().toLowerCase();
  const persistedBase = String(await readFile(join(commonDir, 'happier-stack-stackless-base'), 'utf8').catch(() => '')).trim().toLowerCase();
  const inferredBase = basename(sourceDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  const stackIdentity = /^[a-f0-9]{8,}$/.test(stackId)
    ? {
        id: stackId.slice(0, 20),
        base: persistedBase && /^[a-z0-9][a-z0-9-]*$/.test(persistedBase) ? persistedBase : inferredBase,
      }
    : null;
  return {
    capturedAt: new Date().toISOString(),
    repositoryRoot,
    head,
    headRef,
    refs,
    refsDigest: refsDigest(refs),
    dirtyEntryCount: status.split('\0').filter(Boolean).length,
    worktreeCount: worktrees.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length,
    detachedWorktreeCount: worktrees.split(/\r?\n/).filter((line) => line === 'detached').length,
    worktreeHeads,
    ...(stackIdentity ? { stackIdentity } : {}),
  };
}

async function defaultApplyGuestStackIdentity({ executor, profile, guestRepositoryDir, stackIdentity }) {
  if (!stackIdentity) return;
  requireSuccess(await executor.capture('limactl', [
    'shell', profile.instance, '--', 'sh', '-ceu', [
      'repo=$1',
      'id=$2',
      'base=$3',
      'git_dir=$(git -C "$repo" rev-parse --absolute-git-dir)',
      'printf "%s\\n" "$id" >"$git_dir/happier-stack-stackless-id"',
      'printf "%s\\n" "$base" >"$git_dir/happier-stack-stackless-base"',
    ].join('\n'),
    'hstack-candidate-stack-identity',
    guestRepositoryDir,
    stackIdentity.id,
    stackIdentity.base,
  ]), 'candidate repo Stack identity materialization');
}

async function defaultExportGitBundle({ sourceDir, bundlePath, basis }) {
  requireSuccess(
    await runCaptureResult(
      'git',
      [
        '-c', 'core.fsmonitor=false', 'bundle', 'create', bundlePath, '--all',
        ...new Set(basis.worktreeHeads ?? []),
      ],
      { cwd: sourceDir },
    ),
    'Git bundle export',
  );
}

export function renderCandidateGitBootstrapScript() {
  return [
    'set -eu',
    'repo=$1',
    'bundle=$2',
    'manifest=$3',
    'head_ref=$4',
    'expected_head=$5',
    'staging=$6',
    'shift 6',
    'if [ -e "$repo" ] || [ -L "$repo" ]; then',
    '  printf "%s\\n" "candidate repository already exists: $repo" >&2',
    '  exit 73',
    'fi',
    'mkdir -p "$(dirname "$repo")"',
    'rm -rf -- "$staging"',
    'git init -q "$staging"',
    'git -C "$staging" fetch --quiet --update-head-ok "$bundle" "+refs/*:refs/*"',
    'git -C "$staging" symbolic-ref HEAD "$head_ref"',
    'git -C "$staging" read-tree "$expected_head"',
    'git -C "$staging" checkout-index -a',
    'actual_head=$(git -C "$staging" rev-parse HEAD)',
    '[ "$actual_head" = "$expected_head" ]',
    'actual_manifest=${manifest}.actual',
    'git -C "$staging" for-each-ref --sort=refname --format="%(objectname)%09%(refname)" >"$actual_manifest"',
    'cmp "$manifest" "$actual_manifest"',
    'for worktree_head in "$@"; do git -C "$staging" cat-file -e "${worktree_head}^{commit}"; done',
    'rm -f -- "$actual_manifest"',
    'mv "$staging" "$repo"',
    'printf "%s\\n" "$actual_head"',
  ].join('\n');
}

export function renderCandidateGitRefreshScript() {
  return [
    'set -eu',
    'repo=$1',
    'bundle=$2',
    'manifest=$3',
    'head_ref=$4',
    'expected_head=$5',
    'staging=$6',
    'backup=$7',
    'shift 7',
    '[ -d "$repo/.git" ]',
    'rm -rf -- "$staging" "$backup"',
    'git init -q "$staging"',
    'git -C "$staging" fetch --quiet --update-head-ok "$bundle" "+refs/*:refs/*"',
    'git -C "$staging" symbolic-ref HEAD "$head_ref"',
    'git -C "$staging" read-tree "$expected_head"',
    'actual_head=$(git -C "$staging" rev-parse HEAD)',
    '[ "$actual_head" = "$expected_head" ]',
    'actual_manifest=${manifest}.actual',
    'git -C "$staging" for-each-ref --sort=refname --format="%(objectname)%09%(refname)" >"$actual_manifest"',
    'cmp "$manifest" "$actual_manifest"',
    'for worktree_head in "$@"; do git -C "$staging" cat-file -e "${worktree_head}^{commit}"; done',
    'rm -f -- "$actual_manifest"',
    'mv "$repo/.git" "$backup"',
    'if mv "$staging/.git" "$repo/.git"; then',
    '  rm -rf -- "$backup" "$staging"',
    'else',
    '  mv "$backup" "$repo/.git"',
    '  exit 74',
    'fi',
    'printf "%s\\n" "$actual_head"',
  ].join('\n');
}

async function defaultBootstrapGuestRepository({
  executor,
  profile,
  guestRepositoryDir,
  bundlePath,
  manifestPath,
  basis,
}) {
  const guestTransferDir = join(profile.guestWorkspaceDir, '.bootstrap');
  const token = randomUUID();
  const guestBundle = join(guestTransferDir, `${token}.bundle`);
  const guestManifest = join(guestTransferDir, `${token}.refs`);
  const guestStaging = `${guestRepositoryDir}.bootstrap-${token}`;
  requireSuccess(await executor.capture('limactl', [
    'shell', profile.instance, '--', 'mkdir', '-p', guestTransferDir,
  ]), 'guest bootstrap directory creation');
  try {
    requireSuccess(await executor.run('limactl', [
      'copy', '--backend=scp', bundlePath, `${profile.instance}:${guestBundle}`,
    ]), 'candidate Git bundle copy');
    requireSuccess(await executor.run('limactl', [
      'copy', '--backend=scp', manifestPath, `${profile.instance}:${guestManifest}`,
    ]), 'candidate ref manifest copy');
    const result = requireSuccess(await executor.capture('limactl', [
      'shell', profile.instance, '--', 'sh', '-ceu', renderCandidateGitBootstrapScript(),
      'hstack-candidate-bootstrap',
      guestRepositoryDir,
      guestBundle,
      guestManifest,
      basis.headRef,
      basis.head,
      guestStaging,
      ...(basis.worktreeHeads ?? []),
    ]), 'candidate Git repository bootstrap');
    return {
      created: true,
      verifiedHead: String(result.out ?? '').trim().split(/\r?\n/).at(-1),
      verifiedRefs: basis.refs.length,
    };
  } finally {
    await executor.capture('limactl', [
      'shell', profile.instance, '--', 'rm', '-f', '--', guestBundle, guestManifest,
    ]).catch(() => {});
    await executor.capture('limactl', [
      'shell', profile.instance, '--', 'rm', '-rf', '--', guestStaging,
    ]).catch(() => {});
  }
}

async function defaultRefreshGuestRepository({
  executor,
  profile,
  guestRepositoryDir,
  bundlePath,
  manifestPath,
  basis,
}) {
  const guestTransferDir = join(profile.guestWorkspaceDir, '.bootstrap');
  const token = randomUUID();
  const guestBundle = join(guestTransferDir, `${token}.bundle`);
  const guestManifest = join(guestTransferDir, `${token}.refs`);
  const guestStaging = `${guestRepositoryDir}.refresh-${token}`;
  const guestBackup = `${guestRepositoryDir}.git-backup-${token}`;
  requireSuccess(await executor.capture('limactl', [
    'shell', profile.instance, '--', 'mkdir', '-p', guestTransferDir,
  ]), 'guest refresh directory creation');
  try {
    requireSuccess(await executor.run('limactl', [
      'copy', '--backend=scp', bundlePath, `${profile.instance}:${guestBundle}`,
    ]), 'candidate Git refresh bundle copy');
    requireSuccess(await executor.run('limactl', [
      'copy', '--backend=scp', manifestPath, `${profile.instance}:${guestManifest}`,
    ]), 'candidate ref refresh manifest copy');
    const result = requireSuccess(await executor.capture('limactl', [
      'shell', profile.instance, '--', 'sh', '-ceu', renderCandidateGitRefreshScript(),
      'hstack-candidate-refresh',
      guestRepositoryDir,
      guestBundle,
      guestManifest,
      basis.headRef,
      basis.head,
      guestStaging,
      guestBackup,
      ...(basis.worktreeHeads ?? []),
    ]), 'candidate Git repository refresh');
    return {
      created: false,
      refreshed: true,
      verifiedHead: String(result.out ?? '').trim().split(/\r?\n/).at(-1),
      verifiedRefs: basis.refs.length,
    };
  } finally {
    await executor.capture('limactl', [
      'shell', profile.instance, '--', 'rm', '-f', '--', guestBundle, guestManifest,
    ]).catch(() => {});
    await executor.capture('limactl', [
      'shell', profile.instance, '--', 'rm', '-rf', '--', guestStaging,
    ]).catch(() => {});
  }
}

async function defaultGuestRepositoryExists({ executor, profile, guestRepositoryDir }) {
  const result = await executor.capture('limactl', [
    'shell', profile.instance, '--', 'test', '-d', join(guestRepositoryDir, '.git'),
  ]);
  return result.exitCode === 0 || result.code === 0;
}

async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function resolveExecutionHostCandidatePaths(profile, env = process.env, workspaceId = '') {
  const baseRoot = join(getHappyStacksHomeDir(env), 'execution-host-candidate');
  if (profile.version === 2) {
    const id = String(workspaceId ?? '').trim();
    const workspace = profile.workspaces.find((entry) => entry.id === id);
    if (!workspace) throw new Error(`[execution-host] unknown execution-host workspace: ${JSON.stringify(id)}`);
    const root = join(baseRoot, 'workspaces', id);
    return {
      root,
      workspaceId: id,
      guestRepositoryDir: workspace.guestDir,
      syncBaseDir: join(getHappyStacksHomeDir(env), 'eh-sync', id),
      stateFile: join(root, 'state.v1.json'),
      sshConfigFile: join(root, 'ssh', 'lima.conf'),
      transferRoot: join(root, 'transfer'),
    };
  }
  const root = baseRoot;
  return {
    root,
    workspaceId: '',
    guestRepositoryDir: join(profile.guestWorkspaceDir, 'dev'),
    syncBaseDir: join(root, 'sync'),
    stateFile: join(root, 'state.v1.json'),
    sshConfigFile: join(root, 'ssh', 'lima.conf'),
    transferRoot: join(root, 'transfer'),
  };
}

export async function readExecutionHostCandidateState(profile, env = process.env, workspaceId = '') {
  if (!profile) return null;
  const { stateFile } = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  const raw = await readFile(stateFile, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 1 || state?.authoritative !== false || state?.activation !== 'candidate') {
      throw new Error('unsupported candidate state');
    }
    return {
      ...state,
      capture: projectCandidateCapture(state.capture),
    };
  } catch (error) {
    throw new Error(`[execution-host] failed to read candidate state ${stateFile}: ${String(error?.message ?? error)}`);
  }
}

function requireCandidateState(state) {
  if (!state) {
    throw new Error('[execution-host] candidate repository is not prepared; run `hstack host mirror` first');
  }
  return state;
}

function candidateSyncTarget(profile, paths, ssh = {}) {
  const ownerId = candidateSyncOwner(paths.workspaceId);
  return {
    name: ownerId,
    platform: 'posix',
    ssh: ssh.ssh ?? 'happier-execution-host-candidate',
    sshConfigFile: ssh.sshConfigFile ?? paths.sshConfigFile,
    repoDir: paths.guestRepositoryDir,
    cliHomeDir: join(profile.guestWorkspaceDir, '.happier'),
  };
}

export async function inspectExecutionHostCandidateMirror(
  { profile, workspaceId = '', env = process.env },
  { inspectSync = inspectDevTargetSync } = {},
) {
  const state = requireCandidateState(await readExecutionHostCandidateState(profile, env, workspaceId));
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  const target = candidateSyncTarget(profile, paths);
  return {
    ...state,
    status: await inspectSync({ target, stackBaseDir: paths.syncBaseDir, env }),
  };
}

export async function syncExecutionHostCandidateMirror(
  { profile, workspaceId = '', env = process.env, executor },
  {
    startRuntime = startManagedLimaInstance,
    getInstanceStatus = getManagedLimaStatus,
    publishSshConfig = publishManagedLimaLocalSshConfig,
    ensureSyncProject = ensureDevTargetSyncProject,
    resumeSync = resumeDevTargetSync,
    flushSync = flushDevTargetSync,
    inspectSync = inspectDevTargetSync,
  } = {},
) {
  const state = requireCandidateState(await readExecutionHostCandidateState(profile, env, workspaceId));
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  await startRuntime({ executor, instance: profile.instance });
  const runtime = await getInstanceStatus({ executor, instance: profile.instance });
  const ssh = await publishSshConfig({
    instance: runtime.instance,
    destination: paths.sshConfigFile,
    alias: 'happier-execution-host-candidate',
  });
  const target = candidateSyncTarget(profile, paths, ssh);
  const syncProject = await ensureSyncProject({
    stackBaseDir: paths.syncBaseDir,
    sourceDir: state.sourceDir,
    targets: [target],
    ownerId: candidateSyncOwner(paths.workspaceId),
    allowIndependentBorrow: false,
    env,
  });
  await resumeSync({ target, env: syncProject.env });
  await flushSync({ target, env: syncProject.env });
  return {
    ...state,
    status: await inspectSync({ target, stackBaseDir: paths.syncBaseDir, env: syncProject.env }),
  };
}

export async function pauseExecutionHostCandidateMirror(
  { profile, workspaceId = '', env = process.env },
  { pauseProject = pauseOwnedDevTargetSyncProject } = {},
) {
  requireCandidateState(await readExecutionHostCandidateState(profile, env, workspaceId));
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  return {
    paused: await pauseProject({
      stackBaseDir: paths.syncBaseDir,
      ownerId: candidateSyncOwner(paths.workspaceId),
      env,
    }),
  };
}

export async function adoptLegacyExecutionHostCandidate(
  { profile, workspaceId, env = process.env, executor },
  { pauseProject = pauseOwnedDevTargetSyncProject } = {},
) {
  if (profile?.version !== 2 || profile.activation !== 'candidate') {
    throw new Error('[execution-host] legacy candidate adoption requires a named candidate profile');
  }
  const workspace = profile.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error(`[execution-host] unknown execution-host workspace: ${workspaceId}`);
  const legacyProfile = { ...profile, version: 1 };
  const legacyPaths = resolveExecutionHostCandidatePaths(legacyProfile, env);
  const legacy = requireCandidateState(await readExecutionHostCandidateState(legacyProfile, env));
  if (resolve(legacy.sourceDir) !== resolve(workspace.hostSourceDir)) {
    throw new Error(`[execution-host] legacy candidate source does not match workspace ${workspaceId}`);
  }
  const namedPaths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  if (await readFile(namedPaths.stateFile, 'utf8').catch(() => null)) {
    throw new Error(`[execution-host] workspace ${workspaceId} candidate state already exists`);
  }
  await pauseProject({
    stackBaseDir: legacyPaths.syncBaseDir,
    ownerId: CANDIDATE_SYNC_OWNER,
    env,
  });
  requireSuccess(await executor.run('limactl', [
    'shell', profile.instance, '--', 'sh', '-ceu', [
      'source_repo=$1',
      'target_repo=$2',
      '[ -d "$source_repo/.git" ]',
      '[ ! -e "$target_repo" ]',
      'mkdir -p "$(dirname "$target_repo")"',
      'mv -- "$source_repo" "$target_repo"',
    ].join('\n'),
    'hstack-adopt-legacy-candidate',
    legacyPaths.guestRepositoryDir,
    namedPaths.guestRepositoryDir,
  ]), 'legacy candidate move');
  const adopted = {
    ...legacy,
    workspaceId,
    guestRepositoryDir: namedPaths.guestRepositoryDir,
    adoptedFrom: {
      guestRepositoryDir: legacyPaths.guestRepositoryDir,
      stateFile: legacyPaths.stateFile,
    },
  };
  await atomicWriteJson(namedPaths.stateFile, adopted);
  return { ...adopted, stateFile: namedPaths.stateFile };
}

async function updateCandidateRepository({
  profile,
  workspaceId,
  sourceDir,
  env,
  executor,
  transferPrefix,
  applyGitState,
  applyGuestStackIdentity,
  captureGitBasis,
  exportGitBundle,
  getInstanceStatus,
  publishSshConfig,
  ensureSyncProject,
  pauseProject,
  resumeSync,
  flushSync,
  bootstrapDependencies,
}) {
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  const ownerId = candidateSyncOwner(paths.workspaceId);
  await mkdir(paths.transferRoot, { recursive: true, mode: 0o700 });
  const transferDir = await mkdtemp(join(paths.transferRoot, transferPrefix));
  const bundlePath = join(transferDir, 'repository.bundle');
  const manifestPath = join(transferDir, 'refs.tsv');
  try {
    const basis = await captureGitBasis({ sourceDir });
    const normalizedBasis = {
      ...basis,
      refsDigest: basis.refsDigest ?? refsDigest(basis.refs),
      worktreeHeads: basis.worktreeHeads ?? [],
    };
    await writeFile(
      manifestPath,
      normalizedBasis.refs.map((ref) => `${ref.object}\t${ref.name}\n`).join(''),
      { encoding: 'utf8', mode: 0o600 },
    );
    await exportGitBundle({ sourceDir, bundlePath, basis: normalizedBasis });
    await pauseProject({
      stackBaseDir: paths.syncBaseDir,
      ownerId,
      env,
    });
    const bootstrap = await applyGitState({
      executor,
      profile,
      guestRepositoryDir: paths.guestRepositoryDir,
      bundlePath,
      manifestPath,
      basis: normalizedBasis,
    });
    await applyGuestStackIdentity({
      executor,
      profile,
      guestRepositoryDir: paths.guestRepositoryDir,
      stackIdentity: normalizedBasis.stackIdentity,
    });
    const status = await getInstanceStatus({ executor, instance: profile.instance });
    const ssh = await publishSshConfig({
      instance: status.instance,
      destination: paths.sshConfigFile,
      alias: 'happier-execution-host-candidate',
    });
    const target = {
      name: ownerId,
      platform: 'posix',
      ssh: ssh.ssh,
      sshConfigFile: ssh.sshConfigFile,
      repoDir: paths.guestRepositoryDir,
      cliHomeDir: join(profile.guestWorkspaceDir, '.happier'),
    };
    const syncProject = await ensureSyncProject({
      stackBaseDir: paths.syncBaseDir,
      sourceDir,
      targets: [target],
      ownerId,
      allowIndependentBorrow: false,
      env,
    });
    await resumeSync({ target, env: syncProject.env });
    // This is an explicit capture barrier. Steady-state synchronization remains continuous;
    // ordinary candidate commands never pause or flush Mutagen.
    await flushSync({ target, env: syncProject.env });
    const baseState = {
      version: 1,
      ...(paths.workspaceId ? { workspaceId: paths.workspaceId } : {}),
      activation: 'candidate',
      authoritative: false,
      sourceDir,
      guestRepositoryDir: paths.guestRepositoryDir,
      capture: projectCandidateCapture(normalizedBasis),
      bootstrap,
      sync: {
        mode: 'continuous-one-way-replica',
        ownership: syncProject.ownership,
        perCommandFlush: false,
      },
    };
    let dependencyResult;
    try {
      dependencyResult = requireSuccess(await bootstrapDependencies({
        target,
        stackBaseDir: paths.syncBaseDir,
        syncAlreadyVerified: true,
        env,
      }), 'candidate dependency bootstrap');
    } catch (error) {
      await atomicWriteJson(paths.stateFile, {
        ...baseState,
        dependencies: { ready: false, preparedAt: null, exitCode: Number(error?.exitCode ?? 1) },
      });
      throw error;
    }
    const state = {
      ...baseState,
      dependencies: {
        ready: true,
        preparedAt: new Date().toISOString(),
        exitCode: dependencyResult.code ?? dependencyResult.exitCode,
      },
    };
    await atomicWriteJson(paths.stateFile, state);
    return { ...state, stateFile: paths.stateFile };
  } finally {
    await rm(transferDir, { recursive: true, force: true });
  }
}

export async function prepareExecutionHostCandidateRepository(
  { profile, workspaceId = '', sourceDir, env = process.env, executor },
  {
    captureGitBasis = defaultCaptureGitBasis,
    exportGitBundle = defaultExportGitBundle,
    bootstrapGuestRepository = defaultBootstrapGuestRepository,
    applyGuestStackIdentity = defaultApplyGuestStackIdentity,
    getInstanceStatus = getManagedLimaStatus,
    publishSshConfig = publishManagedLimaLocalSshConfig,
    ensureSyncProject = ensureDevTargetSyncProject,
    pauseProject = pauseOwnedDevTargetSyncProject,
    resumeSync = resumeDevTargetSync,
    flushSync = flushDevTargetSync,
    bootstrapDependencies = runDevTargetDependencyBootstrap,
  } = {},
) {
  if (profile?.activation !== 'candidate') {
    throw new Error('[execution-host] candidate repository preparation requires activation=candidate');
  }
  return await updateCandidateRepository({
    profile,
    workspaceId,
    sourceDir,
    env,
    executor,
    transferPrefix: 'capture-',
    applyGitState: bootstrapGuestRepository,
    applyGuestStackIdentity,
    captureGitBasis,
    exportGitBundle,
    getInstanceStatus,
    publishSshConfig,
    ensureSyncProject,
    pauseProject,
    resumeSync,
    flushSync,
    bootstrapDependencies,
  });
}

export async function recoverExecutionHostCandidateRepository(
  { profile, workspaceId = '', sourceDir, env = process.env, executor },
  {
    captureGitBasis = defaultCaptureGitBasis,
    exportGitBundle = defaultExportGitBundle,
    refreshGuestRepository = defaultRefreshGuestRepository,
    applyGuestStackIdentity = defaultApplyGuestStackIdentity,
    getInstanceStatus = getManagedLimaStatus,
    publishSshConfig = publishManagedLimaLocalSshConfig,
    ensureSyncProject = ensureDevTargetSyncProject,
    pauseProject = pauseOwnedDevTargetSyncProject,
    resumeSync = resumeDevTargetSync,
    flushSync = flushDevTargetSync,
    bootstrapDependencies = runDevTargetDependencyBootstrap,
  } = {},
) {
  if (profile?.activation !== 'candidate') {
    throw new Error('[execution-host] candidate repository recovery requires activation=candidate');
  }
  if (await readExecutionHostCandidateState(profile, env, workspaceId)) {
    throw new Error('[execution-host] candidate state already exists; use ordinary mirror refresh');
  }
  return await updateCandidateRepository({
    profile,
    workspaceId,
    sourceDir,
    env,
    executor,
    transferPrefix: 'recover-',
    applyGitState: refreshGuestRepository,
    applyGuestStackIdentity,
    captureGitBasis,
    exportGitBundle,
    getInstanceStatus,
    publishSshConfig,
    ensureSyncProject,
    pauseProject,
    resumeSync,
    flushSync,
    bootstrapDependencies,
  });
}

export async function refreshExecutionHostCandidateRepository(
  { profile, workspaceId = '', sourceDir, env = process.env, executor },
  {
    captureGitBasis = defaultCaptureGitBasis,
    exportGitBundle = defaultExportGitBundle,
    bootstrapGuestRepository = defaultBootstrapGuestRepository,
    refreshGuestRepository = defaultRefreshGuestRepository,
    guestRepositoryExists = defaultGuestRepositoryExists,
    applyGuestStackIdentity = defaultApplyGuestStackIdentity,
    getInstanceStatus = getManagedLimaStatus,
    publishSshConfig = publishManagedLimaLocalSshConfig,
    ensureSyncProject = ensureDevTargetSyncProject,
    pauseProject = pauseOwnedDevTargetSyncProject,
    resumeSync = resumeDevTargetSync,
    flushSync = flushDevTargetSync,
    bootstrapDependencies = runDevTargetDependencyBootstrap,
  } = {},
) {
  if (profile?.activation !== 'candidate') {
    throw new Error('[execution-host] candidate repository refresh requires activation=candidate');
  }
  const previous = await readExecutionHostCandidateState(profile, env, workspaceId);
  if (!previous) {
    throw new Error('[execution-host] candidate repository is not prepared; run `hstack host mirror` first');
  }
  if (resolve(previous.sourceDir) !== resolve(sourceDir)) {
    throw new Error(`[execution-host] candidate source mismatch: expected ${previous.sourceDir}`);
  }
  return await updateCandidateRepository({
    profile,
    workspaceId,
    sourceDir,
    env,
    executor,
    transferPrefix: 'refresh-',
    applyGitState: async (input) => {
      const repositoryExists = await guestRepositoryExists({
        executor,
        profile,
        guestRepositoryDir: input.guestRepositoryDir,
      });
      return await (repositoryExists ? refreshGuestRepository : bootstrapGuestRepository)(input);
    },
    applyGuestStackIdentity,
    captureGitBasis,
    exportGitBundle,
    getInstanceStatus,
    publishSshConfig,
    ensureSyncProject,
    pauseProject,
    resumeSync,
    flushSync,
    bootstrapDependencies,
  });
}
