import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';

import { activateRuntimeForAuthority } from './runtime_activate.mjs';
import { selectRuntimeSnapshot } from './build/activate_runtime_snapshot.mjs';
import { resolveStackRuntimeComponentSnapshots, resolveStackRuntimeLaunchContext } from './runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import { inspectStackRuntimeSelection } from './runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { writeManagedRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

async function mixedPlacedSnapshots(t) {
  const { root } = await createTempFixture(t, { prefix: 'runtime-mixed-placement-' });
  const hostTarget = { platform: 'linux', arch: 'arm64' };
  const serverTarget = { platform: 'darwin', arch: 'arm64' };
  const authority = { consumerStackName: 'qa', consumerStackBaseDir: join(root, 'qa'),
    producerStackName: 'producer', producerStackBaseDir: join(root, 'producer') };
  const snapshots = {};
  for (const [snapshotId, component, target, createdAt] of [
    ['server-darwin', 'server', serverTarget, '2026-10-06T01:00:00Z'],
    ['daemon-arm64', 'daemon', hostTarget, '2026-10-06T02:00:00Z'],
    ['daemon-x64', 'daemon', { platform: 'linux', arch: 'x64' }, '2026-10-06T03:00:00Z'],
  ]) {
    const snapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: authority.producerStackBaseDir, snapshotId, target });
    snapshot.manifest.components = { [component]: snapshot.manifest.components[component] };
    snapshot.manifest.createdAt = createdAt;
    await writeFile(join(snapshot.snapshotPath, 'manifest.json'), JSON.stringify(snapshot.manifest));
    for (const unused of ['web', 'server', 'daemon'].filter(value => value !== component)) {
      await rm(join(authority.producerStackBaseDir, 'artifacts', unused, `${unused}-${snapshotId}`), { recursive: true, force: true });
    }
    snapshots[snapshotId] = snapshot;
  }
  await selectRuntimeSnapshot({ ...authority, snapshotId: 'server-darwin', target: serverTarget, requiredComponents: ['server'] });
  const target = { name: 'mac-host', platform: 'posix', ssh: 'mac-host', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const policy = { server: { mode: 'prefer-target', target: target.name, fallback: 'error' },
    daemons: { mode: 'local' }, expo: { mode: 'local' }, commands: { mode: 'local' } };
  const placement = { target, runtimeTarget: serverTarget, daemonTarget: null, daemonRuntimeTarget: null,
    config: { version: 3, targets: [target, { name: 'windows1-linux' }],
      runtimePlacement: { server: policy.server, daemon: policy.daemons },
      commandExecution: { mode: 'prefer-target', target: 'windows1-linux', fallback: 'local' } },
    policy, targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }],
  };
  const env = { HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_STORAGE_DIR: root,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev' };
  return { root, authority, placement, hostTarget, serverTarget, env, snapshots };
}

test('start and doctor compose the placed Darwin server with the local ARM64 daemon despite an x64 command worker', async (t) => {
  const { authority, placement, hostTarget, serverTarget, env } = await mixedPlacedSnapshots(t);
  const context = await resolveStackRuntimeLaunchContext({ argv: ['--runtime'], env,
    target: serverTarget, requiredComponents: ['server'], placement, hostTarget, purpose: 'deployment' });
  assert.equal(context.snapshot.snapshotId, 'server-darwin');
  assert.equal(context.componentSnapshots.daemon.snapshotId, 'daemon-arm64');
  assert.deepEqual(context.componentTargets.daemon, [hostTarget]);
  const inspection = await inspectStackRuntimeSelection({ stackName: 'qa', stackBaseDir: authority.consumerStackBaseDir,
    env: { ...env, HAPPIER_STACK_STACK: 'invalid/ambient-stack' }, placement, hostTarget });
  assert.equal(inspection.valid, true, inspection.errors.join('; '));
  assert.equal(inspection.componentSnapshots.daemon.snapshotId, 'daemon-arm64');
});

test('mixed server and daemon activation reuses existing placed snapshots without publishing a Darwin daemon', async (t) => {
  const { root, authority, placement, hostTarget, serverTarget, env } = await mixedPlacedSnapshots(t);
  const before = await readdir(join(authority.producerStackBaseDir, 'runtime/builds'));
  const result = await activateRuntimeForAuthority({ rootDir: process.cwd(), stackName: 'qa', authority,
    selectedComponents: { web: false, server: true, daemon: true }, placement, hostTarget,
    target: serverTarget, env });
  assert.equal(result.runtime.snapshotId, 'server-darwin');
  assert.equal(result.componentSnapshots.daemon.snapshotId, 'daemon-arm64');
  assert.deepEqual(await readdir(join(authority.producerStackBaseDir, 'runtime/builds')), before);
  assert.equal(JSON.parse(await readFile(join(root, 'qa/runtime/current.json'), 'utf8')).snapshotId, 'server-darwin');
});

test('mixed selection admits the daemon placement before writing the primary server pointer', async (t) => {
  const { authority, placement, hostTarget, env, snapshots } = await mixedPlacedSnapshots(t);
  const currentPath = join(authority.consumerStackBaseDir, 'runtime/current.json');
  const before = await readFile(currentPath, 'utf8');
  await rm(snapshots['daemon-arm64'].snapshotPath, { recursive: true, force: true });
  const missing = await resolveStackRuntimeComponentSnapshots({ stackName: 'qa', stackBaseDir: authority.consumerStackBaseDir,
    placement, hostTarget, env, select: true });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join('; '), /daemon.*linux\/arm64/);
  assert.equal(await readFile(currentPath, 'utf8'), before);
  const diagnostic = await inspectStackRuntimeSelection({ stackBaseDir: authority.consumerStackBaseDir, placement, hostTarget, env });
  assert.equal(diagnostic.valid, false);
  assert.match(diagnostic.errors.join('; '), /daemon.*linux\/arm64/);
});

test('shared-DB daemon-only activation retains the selected server and resolves the daemon placement host', async (t) => {
  const { authority, placement, hostTarget, serverTarget, env } = await mixedPlacedSnapshots(t);
  const result = await activateRuntimeForAuthority({ rootDir: process.cwd(), stackName: 'qa', authority,
    selectedComponents: { web: false, server: false, daemon: true }, placement, hostTarget,
    target: serverTarget, env });
  assert.equal(result.runtime.snapshotId, 'server-darwin');
  assert.equal(result.componentSnapshots.daemon.snapshotId, 'daemon-arm64');
  assert.equal(JSON.parse(await readFile(join(authority.consumerStackBaseDir, 'runtime/current.json'), 'utf8')).snapshotId, 'server-darwin');
});

test('runtime activation discovers artifacts outside the snapshot lock and commits only under that lock', async () => {
  const events = [];
  let snapshotLockHeld = false;
  let publicationLockHeld = false;
  const authority = {
    consumerStackName: 'qa-consumer',
    consumerStackBaseDir: '/stacks/qa-consumer',
    producerStackName: 'repo-producer',
    producerStackBaseDir: '/stacks/repo-producer',
  };

  const result = await activateRuntimeForAuthority({
    rootDir: '/repo',
    stackName: 'qa-consumer',
    selectedComponents: { web: false, server: true, daemon: false },
    authority,
    env: {},
    retentionPolicy: { runtimeSnapshotKeepCount: 2, artifactKeepCount: 2 },
    collectBuildSourceMetadataImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      events.push('source-metadata');
      return {
        sourceFingerprint: 'provenance-only',
        builtAt: '2026-08-16T12:00:00.000Z',
        serverComponent: 'happier-server-light',
        dbProvider: 'sqlite',
      };
    },
    resolveLatestComponentArtifactImpl: async ({ component }) => {
      assert.equal(component, 'server');
      events.push(snapshotLockHeld ? 'resolve-server-at-commit' : 'resolve-server');
      return {
        artifactDir: '/stacks/repo-producer/artifacts/server/server-new',
        manifest: { artifactFingerprint: 'server-new' },
      };
    },
    withWorkspaceBundleLockImpl: async (fn, options) => {
      if (options.lockPath === join(authority.producerStackBaseDir, 'runtime', 'publication.lock')) {
        publicationLockHeld = true;
        try { return await fn({ waited: false }); } finally { publicationLockHeld = false; }
      }
      assert.equal(publicationLockHeld, true);
      assert.equal(options.lockPath, join(authority.producerStackBaseDir, 'runtime', 'build.lock'));
      snapshotLockHeld = true;
      try {
        return await fn({ waited: false });
      } finally {
        snapshotLockHeld = false;
      }
    },
    inspectActiveRuntimeSnapshotImpl: async () => {
      assert.equal(snapshotLockHeld, true);
      events.push('validate-current');
      return {
        valid: true,
        manifest: {
          components: {
            web: { artifactFingerprint: 'web-current' },
            server: { artifactFingerprint: 'server-current' },
            daemon: { artifactFingerprint: 'daemon-current' },
          },
        },
      };
    },
    publishRuntimeSnapshotImpl: async (input) => {
      assert.equal(snapshotLockHeld, true);
      assert.equal(input.pruneAfterPublish, false);
      events.push('publish-manifest');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        reused: false,
      };
    },
    selectRuntimeSnapshotImpl: async (input) => {
      assert.equal(snapshotLockHeld, true);
      events.push(input.consumerStackBaseDir === authority.producerStackBaseDir ? 'select-producer' : 'select-consumer');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        currentPath: `${input.consumerStackBaseDir}/runtime/current.json`,
      };
    },
    pruneRuntimeSnapshotsImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      assert.equal(publicationLockHeld, true);
      events.push('retention');
    },
    ensureStackRuntimeModePreferImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      events.push('runtime-mode');
    },
  });

  assert.deepEqual(events, [
    'source-metadata',
    'resolve-server',
    'validate-current',
    'publish-manifest',
    'retention',
    'select-consumer',
    'runtime-mode',
  ]);
  assert.equal(result.runtime.consumerStackName, 'qa-consumer');
  assert.equal(result.runtime.producerStackName, 'repo-producer');
});

test('runtime activation discovers artifacts after publication admission and retains them through commit', async () => {
  let snapshotLockHeld = false;
  let publicationLockHeld = false;
  let resolveCount = 0;
  const authority = {
    consumerStackName: 'qa-consumer',
    consumerStackBaseDir: '/stacks/qa-consumer',
    producerStackName: 'repo-producer',
    producerStackBaseDir: '/stacks/repo-producer',
  };

  const result = await activateRuntimeForAuthority({
    rootDir: '/repo',
    stackName: 'qa-consumer',
    selectedComponents: { web: false, server: true, daemon: false },
    authority,
    env: {},
    retentionPolicy: { runtimeSnapshotKeepCount: 2, artifactKeepCount: 2 },
    collectBuildSourceMetadataImpl: async () => ({
      sourceFingerprint: 'provenance-only',
      builtAt: '2026-08-17T12:00:00.000Z',
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
    }),
    resolveLatestComponentArtifactImpl: async ({ component }) => {
      assert.equal(component, 'server');
      assert.equal(publicationLockHeld, true);
      assert.equal(snapshotLockHeld, false);
      resolveCount += 1;
      return {
        artifactDir: '/stacks/repo-producer/artifacts/server/server-new',
        manifest: { artifactFingerprint: 'server-new' },
      };
    },
    withWorkspaceBundleLockImpl: async (fn, options) => {
      if (options.lockPath.endsWith('publication.lock')) {
        publicationLockHeld = true;
        try { return await fn({ waited: true }); } finally { publicationLockHeld = false; }
      }
      snapshotLockHeld = true;
      try {
        return await fn({ waited: true });
      } finally {
        snapshotLockHeld = false;
      }
    },
    inspectActiveRuntimeSnapshotImpl: async () => ({
      valid: true,
      manifest: {
        components: {
          web: { artifactFingerprint: 'web-current' },
          server: { artifactFingerprint: 'server-new' },
          daemon: { artifactFingerprint: 'daemon-current' },
        },
      },
    }),
    publishRuntimeSnapshotImpl: async (input) => {
      assert.equal(input.artifacts.server.manifest.artifactFingerprint, 'server-new');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        reused: false,
      };
    },
    selectRuntimeSnapshotImpl: async (input) => ({
      snapshotId: input.snapshotId,
      snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
      currentPath: `${input.consumerStackBaseDir}/runtime/current.json`,
    }),
    pruneRuntimeSnapshotsImpl: async () => {},
    ensureStackRuntimeModePreferImpl: async () => {},
  });

  assert.equal(resolveCount, 1);
  assert.equal(result.artifacts.server.manifest.artifactFingerprint, 'server-new');
});
