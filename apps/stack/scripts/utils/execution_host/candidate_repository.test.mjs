import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  inspectExecutionHostCandidateMirror,
  pauseExecutionHostCandidateMirror,
  prepareExecutionHostCandidateRepository,
  readExecutionHostCandidateState,
  refreshExecutionHostCandidateRepository,
  renderCandidateGitBootstrapScript,
  renderCandidateGitRefreshScript,
  resolveExecutionHostCandidatePaths,
  syncExecutionHostCandidateMirror,
} from './candidate_repository.mjs';

const profile = {
  version: 1,
  mode: 'managed-lima',
  activation: 'candidate',
  instance: 'happier-dev-bench',
  limaHome: '/private/lima',
  profile: 'balanced',
  guestWorkspaceDir: '/home/dev/.happier-stack/workspace',
  mirrorWorkspaceDir: '/Users/dev/.happier-stack/workspace-mirror',
};

const namedProfile = {
  ...profile,
  version: 2,
  controllerEntrypoint: '/Users/dev/happier/dev/apps/stack/scripts/execution_host_bridge.mjs',
  workspaces: [
    {
      id: '0.2',
      hostSourceDir: '/Users/dev/happier/remote-dev',
      hostMirrorDir: '/Users/dev/.happier-stack/workspace-mirror/0.2',
      guestDir: '/home/dev/.happier-stack/workspace/0.2',
    },
    {
      id: '0.3',
      hostSourceDir: '/Users/dev/happier/dev',
      hostMirrorDir: '/Users/dev/.happier-stack/workspace-mirror/0.3',
      guestDir: '/home/dev/.happier-stack/workspace/0.3',
    },
  ],
};

test('candidate paths isolate the Git bootstrap and continuous sync from the authoritative checkout', () => {
  const paths = resolveExecutionHostCandidatePaths(profile, {
    HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack',
  });

  assert.equal(paths.guestRepositoryDir, '/home/dev/.happier-stack/workspace/dev');
  assert.equal(paths.syncBaseDir, '/Users/dev/.happier-stack/execution-host-candidate/sync');
  assert.equal(paths.stateFile, '/Users/dev/.happier-stack/execution-host-candidate/state.v1.json');
  assert.equal(paths.sshConfigFile, '/Users/dev/.happier-stack/execution-host-candidate/ssh/lima.conf');
});

test('named candidate paths isolate each workspace state, transport, and guest checkout', () => {
  const env = { HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack' };
  const zeroTwo = resolveExecutionHostCandidatePaths(namedProfile, env, '0.2');
  const zeroThree = resolveExecutionHostCandidatePaths(namedProfile, env, '0.3');

  assert.equal(zeroTwo.guestRepositoryDir, '/home/dev/.happier-stack/workspace/0.2');
  assert.equal(zeroThree.guestRepositoryDir, '/home/dev/.happier-stack/workspace/0.3');
  assert.equal(zeroTwo.stateFile, '/Users/dev/.happier-stack/execution-host-candidate/workspaces/0.2/state.v1.json');
  assert.equal(zeroThree.stateFile, '/Users/dev/.happier-stack/execution-host-candidate/workspaces/0.3/state.v1.json');
  assert.notEqual(zeroTwo.syncBaseDir, zeroThree.syncBaseDir);
  assert.throws(
    () => resolveExecutionHostCandidatePaths(namedProfile, env, 'missing'),
    /unknown execution-host workspace/,
  );
});

test('candidate preparation bootstraps Git before starting the canonical continuous one-way sync', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-candidate-repository-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const refs = [
    { name: 'refs/heads/dev', object: 'a'.repeat(40) },
    { name: 'refs/tags/v0.2.0', object: 'b'.repeat(40) },
  ];

  const result = await prepareExecutionHostCandidateRepository({
    profile,
    sourceDir: '/Users/dev/happier/dev',
    env: { HAPPIER_STACK_HOME_DIR: home },
  }, {
    captureGitBasis: async () => ({
      capturedAt: '2026-08-25T12:00:00.000Z',
      repositoryRoot: '/Users/dev/happier/dev',
      head: 'a'.repeat(40),
      headRef: 'refs/heads/dev',
      refs,
      dirtyEntryCount: 17,
      worktreeCount: 215,
    }),
    exportGitBundle: async ({ bundlePath }) => {
      calls.push(['bundle', bundlePath]);
    },
    bootstrapGuestRepository: async ({ guestRepositoryDir, bundlePath, basis }) => {
      calls.push(['bootstrap', guestRepositoryDir, bundlePath, basis.headRef]);
      return { created: true, verifiedHead: basis.head, verifiedRefs: refs.length };
    },
    getInstanceStatus: async () => ({ instance: { sshConfigFile: '/private/lima-ssh.conf' } }),
    publishSshConfig: async ({ destination }) => {
      calls.push(['ssh', destination]);
      return { ssh: 'happier-candidate', sshConfigFile: destination };
    },
    ensureSyncProject: async ({ stackBaseDir, sourceDir, targets, ownerId }) => {
      calls.push(['sync-project', stackBaseDir, sourceDir, targets[0].repoDir, ownerId]);
      return { env: { MUTAGEN_DATA_DIRECTORY: '/private/mutagen' }, ownership: 'owned' };
    },
    resumeSync: async ({ target }) => {
      calls.push(['resume', target.name]);
    },
    flushSync: async ({ target }) => {
      calls.push(['flush-once', target.name]);
    },
    bootstrapDependencies: async ({ target, syncAlreadyVerified }) => {
      calls.push(['dependencies', target.name, syncAlreadyVerified]);
      return { code: 0 };
    },
  });

  assert.equal(result.authoritative, false);
  assert.equal(result.activation, 'candidate');
  assert.equal(result.sync.mode, 'continuous-one-way-replica');
  assert.equal(result.sync.perCommandFlush, false);
  assert.deepEqual(calls.map(([kind]) => kind), [
    'bundle',
    'bootstrap',
    'ssh',
    'sync-project',
    'resume',
    'flush-once',
    'dependencies',
  ]);
  const state = JSON.parse(await readFile(result.stateFile, 'utf8'));
  assert.equal(state.authoritative, false);
  assert.equal(state.capture.head, 'a'.repeat(40));
  assert.equal(state.capture.dirtyEntryCount, 17);
  assert.equal(state.capture.refCount, 2);
  assert.equal('refs' in state.capture, false);
  assert.equal('worktreeHeads' in state.capture, false);
  assert.equal(state.dependencies.ready, true);
  assert.equal(state.sync.perCommandFlush, false);
});

test('candidate state reader projects legacy unbounded capture arrays to counts and digests', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-candidate-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveExecutionHostCandidatePaths(profile, { HAPPIER_STACK_HOME_DIR: home });
  await mkdir(join(home, 'execution-host-candidate'), { recursive: true });
  await writeFile(paths.stateFile, JSON.stringify({
    version: 1,
    activation: 'candidate',
    authoritative: false,
    capture: {
      head: 'a'.repeat(40),
      refs: [
        { name: 'refs/heads/dev', object: 'a'.repeat(40) },
        { name: 'refs/tags/v1', object: 'b'.repeat(40) },
      ],
      worktreeHeads: ['a'.repeat(40), 'c'.repeat(40)],
    },
  }));

  const state = await readExecutionHostCandidateState(profile, {
    HAPPIER_STACK_HOME_DIR: home,
  });

  assert.equal(state.capture.refCount, 2);
  assert.match(state.capture.refsDigest, /^[0-9a-f]{64}$/);
  assert.equal(state.capture.worktreeHeadCount, 2);
  assert.equal('refs' in state.capture, false);
  assert.equal('worktreeHeads' in state.capture, false);
});

test('candidate preparation cannot run after authority activation', async () => {
  await assert.rejects(
    prepareExecutionHostCandidateRepository({
      profile: { ...profile, activation: 'active' },
      sourceDir: '/Users/dev/happier/dev',
      env: { HAPPIER_STACK_HOME_DIR: '/tmp/happier-candidate-test' },
    }),
    /requires activation=candidate/,
  );
});

test('candidate refresh replaces only captured Git state then reuses sync and dependency owners', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-candidate-refresh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveExecutionHostCandidatePaths(profile, { HAPPIER_STACK_HOME_DIR: home });
  await mkdir(join(home, 'execution-host-candidate'), { recursive: true });
  await writeFile(paths.stateFile, JSON.stringify({
    version: 1,
    activation: 'candidate',
    authoritative: false,
    sourceDir: '/Users/dev/happier/dev',
    capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
  }));
  const calls = [];
  const refs = [{ name: 'refs/heads/dev', object: 'b'.repeat(40) }];

  const result = await refreshExecutionHostCandidateRepository({
    profile,
    sourceDir: '/Users/dev/happier/dev',
    env: { HAPPIER_STACK_HOME_DIR: home },
  }, {
    captureGitBasis: async () => ({
      capturedAt: '2026-08-26T00:00:00.000Z',
      repositoryRoot: '/Users/dev/happier/dev',
      head: 'b'.repeat(40),
      headRef: 'refs/heads/dev',
      refs,
      dirtyEntryCount: 3,
      worktreeCount: 2,
      detachedWorktreeCount: 1,
      worktreeHeads: ['b'.repeat(40)],
    }),
    exportGitBundle: async () => calls.push(['bundle']),
    refreshGuestRepository: async ({ basis }) => {
      calls.push(['refresh-git', basis.head]);
      return { created: false, refreshed: true, verifiedHead: basis.head, verifiedRefs: 1 };
    },
    getInstanceStatus: async () => ({ instance: { sshConfigFile: '/private/lima-ssh.conf' } }),
    publishSshConfig: async ({ destination }) => {
      calls.push(['ssh', destination]);
      return { ssh: 'happier-candidate', sshConfigFile: destination };
    },
    ensureSyncProject: async () => {
      calls.push(['sync-project']);
      return { env: { MUTAGEN_DATA_DIRECTORY: '/private/mutagen' }, ownership: 'owned' };
    },
    resumeSync: async () => calls.push(['resume']),
    flushSync: async () => calls.push(['flush-once']),
    bootstrapDependencies: async () => {
      calls.push(['dependencies']);
      return { code: 0 };
    },
  });

  assert.deepEqual(calls.map(([kind]) => kind), [
    'bundle', 'refresh-git', 'ssh', 'sync-project', 'resume', 'flush-once', 'dependencies',
  ]);
  assert.equal(result.capture.head, 'b'.repeat(40));
  assert.equal(result.capture.refCount, 1);
  assert.equal(result.capture.worktreeHeadCount, 1);
  assert.equal(result.bootstrap.refreshed, true);
  assert.equal(result.dependencies.ready, true);
});

test('candidate mirror sync resumes continuous transport without recapturing Git or dependencies', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-candidate-mirror-sync-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveExecutionHostCandidatePaths(profile, { HAPPIER_STACK_HOME_DIR: home });
  await mkdir(join(home, 'execution-host-candidate'), { recursive: true });
  await writeFile(paths.stateFile, JSON.stringify({
    version: 1,
    activation: 'candidate',
    authoritative: false,
    sourceDir: '/Users/dev/happier/dev',
    guestRepositoryDir: paths.guestRepositoryDir,
    capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
  }));
  const calls = [];

  const result = await syncExecutionHostCandidateMirror({
    profile,
    env: { HAPPIER_STACK_HOME_DIR: home },
    executor: {},
  }, {
    startRuntime: async () => calls.push('start-runtime'),
    getInstanceStatus: async () => ({ instance: { sshConfigFile: '/private/lima-ssh.conf' } }),
    publishSshConfig: async () => {
      calls.push('publish-ssh');
      return { ssh: 'happier-candidate', sshConfigFile: paths.sshConfigFile };
    },
    ensureSyncProject: async () => {
      calls.push('ensure-sync-project');
      return { env: { MUTAGEN_DATA_DIRECTORY: '/private/mutagen' }, ownership: 'owned' };
    },
    resumeSync: async () => calls.push('resume'),
    flushSync: async () => calls.push('flush-once'),
    inspectSync: async () => ({ state: 'ready', sessionName: 'happier-execution--host--candidate' }),
  });

  assert.deepEqual(calls, [
    'start-runtime', 'publish-ssh', 'ensure-sync-project', 'resume', 'flush-once',
  ]);
  assert.equal(result.status.state, 'ready');
  assert.equal(result.capture.head, 'a'.repeat(40));
});

test('candidate mirror status is read-only and stop pauses only the owned transport', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-candidate-mirror-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveExecutionHostCandidatePaths(profile, { HAPPIER_STACK_HOME_DIR: home });
  await mkdir(join(home, 'execution-host-candidate'), { recursive: true });
  await writeFile(paths.stateFile, JSON.stringify({
    version: 1,
    activation: 'candidate',
    authoritative: false,
    sourceDir: '/Users/dev/happier/dev',
    guestRepositoryDir: paths.guestRepositoryDir,
    capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
  }));
  const calls = [];

  const status = await inspectExecutionHostCandidateMirror({
    profile,
    env: { HAPPIER_STACK_HOME_DIR: home },
  }, {
    inspectSync: async () => {
      calls.push('inspect');
      return { state: 'ready', sessionName: 'happier-execution--host--candidate' };
    },
  });
  const stopped = await pauseExecutionHostCandidateMirror({
    profile,
    env: { HAPPIER_STACK_HOME_DIR: home },
  }, {
    pauseProject: async () => {
      calls.push('pause');
      return true;
    },
  });

  assert.equal(status.status.state, 'ready');
  assert.equal(stopped.paused, true);
  assert.deepEqual(calls, ['inspect', 'pause']);
});

test('candidate Git bootstrap reproduces exact refs and detached worktree commits without clone-added refs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-git-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'candidate');
  const staging = join(root, 'candidate.staging');
  const bundle = join(root, 'repository.bundle');
  const manifest = join(root, 'refs.tsv');
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: source,
    encoding: 'utf8',
    ...options,
  }).trim();
  execFileSync('git', ['init', '-q', source]);
  git(['config', 'user.email', 'candidate@example.com']);
  git(['config', 'user.name', 'Candidate Test']);
  await writeFile(join(source, 'tracked.txt'), 'tracked\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'tracked']);
  const head = git(['rev-parse', 'HEAD']);
  git(['tag', 'candidate-tag']);
  const detachedTree = git(['rev-parse', 'HEAD^{tree}']);
  const detached = git(['commit-tree', detachedTree, '-p', head, '-m', 'detached worktree head']);
  git(['bundle', 'create', bundle, '--all', detached]);
  const expectedRefs = git(['for-each-ref', '--sort=refname', '--format=%(objectname)%09%(refname)']);
  await writeFile(manifest, `${expectedRefs}\n`);

  execFileSync('sh', [
    '-ceu',
    renderCandidateGitBootstrapScript(),
    'hstack-candidate-bootstrap',
    destination,
    bundle,
    manifest,
    'refs/heads/main',
    head,
    staging,
    detached,
  ], { encoding: 'utf8' });

  assert.equal(execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  assert.equal(
    execFileSync('git', ['-C', destination, 'for-each-ref', '--sort=refname', '--format=%(objectname)%09%(refname)'], { encoding: 'utf8' }).trim(),
    expectedRefs,
  );
  execFileSync('git', ['-C', destination, 'cat-file', '-e', `${detached}^{commit}`]);
});

test('candidate Git refresh atomically replaces captured refs and index without recreating the working tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-git-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'candidate');
  const initialStaging = join(root, 'candidate.initial');
  const refreshStaging = join(root, 'candidate.refresh');
  const refreshBackup = join(root, 'candidate.backup');
  const bundle = join(root, 'repository.bundle');
  const manifest = join(root, 'refs.tsv');
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: source,
    encoding: 'utf8',
    ...options,
  }).trim();
  execFileSync('git', ['init', '-q', source]);
  git(['config', 'user.email', 'candidate@example.com']);
  git(['config', 'user.name', 'Candidate Test']);
  await writeFile(join(source, 'tracked.txt'), 'initial\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'initial']);
  const initialHead = git(['rev-parse', 'HEAD']);
  git(['bundle', 'create', bundle, '--all']);
  await writeFile(manifest, `${git(['for-each-ref', '--sort=refname', '--format=%(objectname)%09%(refname)'])}\n`);
  execFileSync('sh', [
    '-ceu', renderCandidateGitBootstrapScript(), 'bootstrap', destination, bundle, manifest,
    'refs/heads/main', initialHead, initialStaging,
  ]);

  await writeFile(join(source, 'tracked.txt'), 'refreshed\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'refreshed']);
  git(['tag', 'new-tag']);
  const refreshedHead = git(['rev-parse', 'HEAD']);
  await rm(bundle);
  git(['bundle', 'create', bundle, '--all']);
  const refreshedRefs = git(['for-each-ref', '--sort=refname', '--format=%(objectname)%09%(refname)']);
  await writeFile(manifest, `${refreshedRefs}\n`);
  await writeFile(join(destination, 'working-tree-local.txt'), 'preserved\n');

  execFileSync('sh', [
    '-ceu', renderCandidateGitRefreshScript(), 'refresh', destination, bundle, manifest,
    'refs/heads/main', refreshedHead, refreshStaging, refreshBackup,
  ]);

  assert.equal(execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), refreshedHead);
  assert.equal(
    execFileSync('git', ['-C', destination, 'for-each-ref', '--sort=refname', '--format=%(objectname)%09%(refname)'], { encoding: 'utf8' }).trim(),
    refreshedRefs,
  );
  assert.equal(await readFile(join(destination, 'working-tree-local.txt'), 'utf8'), 'preserved\n');
});
