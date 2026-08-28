import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { renderMutagenProject } from './utils/dev_targets/mutagen_project.mjs';
import {
  resolveExecutionHostCandidatePaths,
  syncExecutionHostCandidateMirror,
} from './utils/execution_host/candidate_repository.mjs';

const script = new URL('./host.mjs', import.meta.url).pathname;

function namedCandidateProfile({ home, mirrorRoot }) {
  return {
    version: 2,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'happier-dev',
    limaHome: join(home, 'lima'),
    profile: 'balanced',
    pressureProfile: 'none',
    guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
    mirrorWorkspaceDir: mirrorRoot,
    controllerEntrypoint: join(mirrorRoot, 'controller.mjs'),
    workspaces: [
      {
        id: '0.2',
        hostSourceDir: join(home, 'source-0.2'),
        hostMirrorDir: join(mirrorRoot, '0.2'),
        guestDir: '/home/happier/.happier-stack/workspace/0.2',
      },
      {
        id: '0.3',
        hostSourceDir: join(home, 'source-0.3'),
        hostMirrorDir: join(mirrorRoot, '0.3'),
        guestDir: '/home/happier/.happier-stack/workspace/0.3',
      },
    ],
  };
}

async function writeCandidateMirrorState({ profile, home, workspaceId }) {
  const env = { HAPPIER_STACK_HOME_DIR: home };
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  const workspace = profile.workspaces.find((entry) => entry.id === workspaceId);
  await mkdir(join(paths.root), { recursive: true });
  await writeFile(paths.stateFile, `${JSON.stringify({
    version: 1,
    workspaceId,
    activation: 'candidate',
    authoritative: false,
    sourceDir: workspace.hostSourceDir,
    guestRepositoryDir: workspace.guestDir,
    capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
  })}\n`, 'utf8');
  await writeCandidateMirrorProject({ profile, home, workspaceId });
}

async function writeCandidateMirrorProject({ profile, home, workspaceId }) {
  const env = { HAPPIER_STACK_HOME_DIR: home };
  const paths = resolveExecutionHostCandidatePaths(profile, env, workspaceId);
  const workspace = profile.workspaces.find((entry) => entry.id === workspaceId);
  await mkdir(join(paths.syncBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(paths.syncBaseDir, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: workspace.hostSourceDir,
    targets: [{
      name: `execution-host-candidate-${workspaceId}`,
      platform: 'posix',
      ssh: 'candidate',
      repoDir: workspace.guestDir,
      cliHomeDir: '/home/happier/.happier-stack/workspace/.happier',
    }],
    ownerId: `execution-host-candidate-${workspaceId}`,
  }), 'utf8');
}

async function writeLegacyCandidateMirrorState({ profile, home, sourceWorkspaceId }) {
  const legacyProfile = { ...profile, version: 1 };
  const env = { HAPPIER_STACK_HOME_DIR: home };
  const paths = resolveExecutionHostCandidatePaths(legacyProfile, env);
  const sourceWorkspace = profile.workspaces.find((entry) => entry.id === sourceWorkspaceId);
  await mkdir(join(paths.syncBaseDir, 'mutagen'), { recursive: true });
  await mkdir(join(paths.root), { recursive: true });
  await writeFile(paths.stateFile, `${JSON.stringify({
    version: 1,
    activation: 'candidate',
    authoritative: false,
    sourceDir: sourceWorkspace.hostSourceDir,
    guestRepositoryDir: paths.guestRepositoryDir,
    capture: { head: 'b'.repeat(40), refCount: 1, refsDigest: '1'.repeat(64), worktreeHeadCount: 1 },
  })}\n`, 'utf8');
  await writeFile(join(paths.syncBaseDir, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: sourceWorkspace.hostSourceDir,
    targets: [{
      name: 'execution-host-candidate',
      platform: 'posix',
      ssh: 'candidate',
      repoDir: paths.guestRepositoryDir,
      cliHomeDir: '/home/happier/.happier-stack/workspace/.happier',
    }],
    ownerId: 'execution-host-candidate',
  }), 'utf8');
}

async function writeFakeMutagen({ bin, log, failingWorkspaceId = '' }) {
  const source = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "project" ] && [ "$2" = "pause" ]; then',
    failingWorkspaceId
      ? `  case "$*" in *${JSON.stringify(`eh-sync/${failingWorkspaceId}/mutagen/mutagen.yml`)}*) exit 41 ;; esac`
      : '  :',
    '  exit 0',
    'fi',
    'if [ "$1" = "sync" ] && [ "$2" = "list" ]; then',
    '  printf \'[{"name":"%s","paused":true,"status":"watching","successfulCycles":1}]\\n\' "$3"',
    '  exit 0',
    'fi',
    'exit 42',
    '',
  ].join('\n');
  await writeFile(join(bin, 'mutagen'), source, 'utf8');
  await chmod(join(bin, 'mutagen'), 0o755);
}

test('dev-vm activate pauses every owned candidate mirror before making a named profile authoritative', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-activate-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('mutagen.log');
  const mirrorRoot = fixture.path('mirror');
  const profile = namedCandidateProfile({ home, mirrorRoot });
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
    writeCandidateMirrorState({ profile, home, workspaceId: '0.2' }),
    writeCandidateMirrorState({ profile, home, workspaceId: '0.3' }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify(profile)}\n`, 'utf8');
  await writeFakeMutagen({ bin, log });

  const result = await runNodeCapture([script, 'activate', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const activated = JSON.parse(result.stdout);
  assert.equal(activated.profile.activation, 'active');
  assert.deepEqual(
    activated.retiredCandidateMirrors.map((mirror) => [mirror.workspaceId, mirror.status.state]),
    [['0.2', 'paused'], ['0.3', 'paused']],
  );
  assert.equal(JSON.parse(await readFile(join(home, 'execution-host.json'), 'utf8')).activation, 'active');
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /project pause --project-file .*eh-sync\/0\.2\/mutagen\/mutagen\.yml/);
  assert.match(calls, /project pause --project-file .*eh-sync\/0\.3\/mutagen\/mutagen\.yml/);
  assert.doesNotMatch(calls, /guest-to-mac|happier-mac/);
});

test('dev-vm activate retires an owned candidate project even when its state publication is missing', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-activate-unpublished-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('mutagen.log');
  const mirrorRoot = fixture.path('mirror');
  const profile = namedCandidateProfile({ home, mirrorRoot });
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
    writeCandidateMirrorProject({ profile, home, workspaceId: '0.3' }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify(profile)}\n`, 'utf8');
  await writeFakeMutagen({ bin, log });

  const result = await runNodeCapture([script, 'activate', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const activated = JSON.parse(result.stdout);
  assert.deepEqual(
    activated.retiredCandidateMirrors.map((mirror) => [mirror.workspaceId, mirror.candidateState, mirror.status.state]),
    [['0.3', 'missing', 'paused']],
  );
  assert.match(await readFile(log, 'utf8'), /project pause --project-file .*eh-sync\/0\.3\/mutagen\/mutagen\.yml/);
});

test('dev-vm activate also retires retained legacy candidate state for a named profile', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-activate-legacy-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('mutagen.log');
  const mirrorRoot = fixture.path('mirror');
  const profile = namedCandidateProfile({ home, mirrorRoot });
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
    writeCandidateMirrorState({ profile, home, workspaceId: '0.3' }),
    writeLegacyCandidateMirrorState({ profile, home, sourceWorkspaceId: '0.3' }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify(profile)}\n`, 'utf8');
  await writeFakeMutagen({ bin, log });

  const result = await runNodeCapture([script, 'activate', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const activated = JSON.parse(result.stdout);
  assert.deepEqual(
    activated.retiredCandidateMirrors.map((mirror) => [mirror.workspaceId, mirror.legacy === true, mirror.status.state]),
    [['0.3', false, 'paused'], ['', true, 'paused']],
  );
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /project pause --project-file .*eh-sync\/0\.3\/mutagen\/mutagen\.yml/);
  assert.match(calls, /project pause --project-file .*execution-host-candidate\/sync\/mutagen\/mutagen\.yml/);
  assert.doesNotMatch(calls, /guest-to-mac|happier-mac/);
});

test('dev-vm activate fails closed when any owned candidate mirror cannot be retired', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-activate-fail-closed-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('mutagen.log');
  const mirrorRoot = fixture.path('mirror');
  const profile = namedCandidateProfile({ home, mirrorRoot });
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
    writeCandidateMirrorState({ profile, home, workspaceId: '0.2' }),
    writeCandidateMirrorState({ profile, home, workspaceId: '0.3' }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify(profile)}\n`, 'utf8');
  await writeFakeMutagen({ bin, log, failingWorkspaceId: '0.3' });

  const result = await runNodeCapture([script, 'activate', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Mutagen project pause failed/);
  assert.equal(JSON.parse(await readFile(join(home, 'execution-host.json'), 'utf8')).activation, 'candidate');
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /project pause --project-file .*eh-sync\/0\.2\/mutagen\/mutagen\.yml/);
  assert.match(calls, /project pause --project-file .*eh-sync\/0\.3\/mutagen\/mutagen\.yml/);
});

test('an active execution-host profile cannot resume a retired candidate mirror', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-active-candidate-resume-' });
  const home = fixture.path('home');
  const profile = namedCandidateProfile({ home, mirrorRoot: fixture.path('mirror') });
  await writeCandidateMirrorState({ profile, home, workspaceId: '0.3' });
  let started = false;

  await assert.rejects(syncExecutionHostCandidateMirror({
    profile: { ...profile, activation: 'active' },
    workspaceId: '0.3',
    env: { HAPPIER_STACK_HOME_DIR: home },
    executor: {},
  }, {
    startRuntime: async () => { started = true; },
  }), /requires activation=candidate/);
  assert.equal(started, false);
});

test('active dev-vm status reports retained candidate metadata only as retired diagnostics', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-active-candidate-status-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('mutagen.log');
  const mirrorRoot = fixture.path('mirror');
  const candidate = namedCandidateProfile({ home, mirrorRoot });
  const profile = { ...candidate, activation: 'active' };
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
    writeCandidateMirrorState({ profile: candidate, home, workspaceId: '0.3' }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify(profile)}\n`, 'utf8');
  await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n', 'utf8');
  await writeFile(join(bin, 'limactl'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf "limactl version 2.1.0\\n"; exit 0; fi',
    'if [ "$1" = "list" ]; then printf "[]\\n"; exit 0; fi',
    'exit 44',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(join(bin, 'uname'), 0o755),
    chmod(join(bin, 'limactl'), 0o755),
    writeFakeMutagen({ bin, log }),
  ]);

  const result = await runNodeCapture([script, 'status', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal('candidateRepository' in status, false);
  assert.equal(status.candidateRetirement.state, 'retired');
  assert.deepEqual(
    status.candidateRetirement.mirrors.map((mirror) => [mirror.workspaceId, mirror.status.state]),
    [['0.3', 'paused']],
  );
  assert.match(await readFile(log, 'utf8'), /sync list happier-execution--host--candidate--0-d-3/);
  assert.doesNotMatch(await readFile(log, 'utf8'), /project pause/);
});

test('dev-vm help exposes activation as the public candidate-retirement handoff', async () => {
  const result = await runNodeCapture([script, '--help'], {
    env: { ...process.env, HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hstack dev-vm activate \[--json\]/);
});
