import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  prepareExecutionHostCandidateRepository,
  renderCandidateGitBootstrapScript,
  resolveExecutionHostCandidatePaths,
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

test('candidate paths isolate the Git bootstrap and continuous sync from the authoritative checkout', () => {
  const paths = resolveExecutionHostCandidatePaths(profile, {
    HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack',
  });

  assert.equal(paths.guestRepositoryDir, '/home/dev/.happier-stack/workspace/dev');
  assert.equal(paths.syncBaseDir, '/Users/dev/.happier-stack/execution-host-candidate/sync');
  assert.equal(paths.stateFile, '/Users/dev/.happier-stack/execution-host-candidate/state.v1.json');
  assert.equal(paths.sshConfigFile, '/Users/dev/.happier-stack/execution-host-candidate/ssh/lima.conf');
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
  ]);
  const state = JSON.parse(await readFile(result.stateFile, 'utf8'));
  assert.equal(state.authoritative, false);
  assert.equal(state.capture.head, 'a'.repeat(40));
  assert.equal(state.capture.dirtyEntryCount, 17);
  assert.equal(state.sync.perCommandFlush, false);
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
