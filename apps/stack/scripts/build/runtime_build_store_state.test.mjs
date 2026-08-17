import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactPayloadDir, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { resolveCompletedRuntimeBuildAfterWait } from './runtime_build_store_state.mjs';
import { writeRuntimeSnapshotLayout } from '../testkit/core/runtime_snapshot_layout.mjs';

let publicationSequence = 0;

async function publishArtifact({ stackBaseDir, component, fingerprint, webArtifactFingerprint = null }) {
  const artifactDir = join(stackBaseDir, 'artifacts', component, fingerprint);
  const payloadDir = artifactPayloadDir(artifactDir);
  const entrypoint = component === 'web' ? 'index.html' : `bin/${component}`;
  await mkdir(join(payloadDir, ...entrypoint.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(payloadDir, entrypoint), `${component}\n`, 'utf8');
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component,
      artifactFingerprint: fingerprint,
      ...(webArtifactFingerprint ? { webArtifactFingerprint } : {}),
      sourceFingerprint: `source-${fingerprint}`,
      source: { sourceFingerprint: `source-${fingerprint}` },
      createdAt: new Date(1_700_000_000_000 + publicationSequence++).toISOString(),
      payloadDir: 'payload',
      entrypoint,
    },
  });
  return artifactDir;
}

test('a waited server request reuses only its newly completed server artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-build-store-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const producerStackBaseDir = join(root, 'producer');
  const consumerStackBaseDir = join(root, 'consumer');
  const selection = {
    components: { web: false, server: true, daemon: false },
    activateRuntime: false,
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-old' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-old',
    webArtifactFingerprint: 'web-old',
  });
  const baselineStoreState = {
    snapshotId: null,
    artifactFingerprints: { server: 'server-old', web: 'web-old' },
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-shared' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-new',
    webArtifactFingerprint: 'web-shared',
  });

  const result = await resolveCompletedRuntimeBuildAfterWait({
    authority: {
      consumerStackName: 'agent-qa',
      consumerStackBaseDir,
      producerStackName: 'repo-producer',
      producerStackBaseDir,
    },
    selection,
    baselineStoreState,
    expectedArtifactFingerprints: { server: 'server-new' },
  });

  assert.equal(result?.reused, true);
  assert.equal(result?.selected, false);
  assert.equal(result?.artifacts?.server?.manifest?.artifactFingerprint, 'server-new');
  assert.equal(result?.artifacts?.web, undefined);

  const newerThanRequested = await resolveCompletedRuntimeBuildAfterWait({
    authority: {
      consumerStackName: 'agent-qa',
      consumerStackBaseDir,
      producerStackName: 'repo-producer',
      producerStackBaseDir,
    },
    selection,
    baselineStoreState,
    expectedArtifactFingerprints: { server: 'server-other' },
  });
  assert.equal(newerThanRequested?.artifacts?.server?.manifest?.artifactFingerprint, 'server-new');
});

test('a waited artifact request does not reuse a publication that changed no requested component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-build-store-mismatch-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const producerStackBaseDir = join(root, 'producer');
  const consumerStackBaseDir = join(root, 'consumer');
  const selection = {
    components: { web: false, server: true, daemon: false },
    activateRuntime: false,
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-old' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-old',
    webArtifactFingerprint: 'web-old',
  });
  const baselineStoreState = {
    snapshotId: null,
    artifactFingerprints: { server: 'server-old', web: 'web-old' },
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'daemon', fingerprint: 'daemon-unrelated' });

  assert.equal(
    await resolveCompletedRuntimeBuildAfterWait({
      authority: {
        consumerStackName: 'agent-qa',
        consumerStackBaseDir,
        producerStackName: 'repo-producer',
        producerStackBaseDir,
      },
      selection,
      baselineStoreState,
      expectedArtifactFingerprints: { server: 'server-requested' },
    }),
    null,
  );
});

test('a waited artifact request reuses a newer partial publication when unchanged requested components already match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-build-store-partial-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const producerStackBaseDir = join(root, 'producer');
  const consumerStackBaseDir = join(root, 'consumer');
  const selection = {
    components: { web: false, server: true, daemon: true },
    activateRuntime: false,
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-old' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-old',
    webArtifactFingerprint: 'web-old',
  });
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'daemon', fingerprint: 'daemon-current' });
  const baselineStoreState = {
    snapshotId: null,
    artifactFingerprints: {
      web: 'web-old',
      server: 'server-old',
      daemon: 'daemon-current',
    },
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-new' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-new',
    webArtifactFingerprint: 'web-new',
  });

  const result = await resolveCompletedRuntimeBuildAfterWait({
    authority: {
      consumerStackName: 'agent-qa',
      consumerStackBaseDir,
      producerStackName: 'repo-producer',
      producerStackBaseDir,
    },
    selection,
    baselineStoreState,
    expectedArtifactFingerprints: {
      server: 'server-requested-before-wait',
      daemon: 'daemon-current',
    },
  });

  assert.equal(result?.artifacts?.server?.manifest?.artifactFingerprint, 'server-new');
  assert.equal(result?.artifacts?.daemon?.manifest?.artifactFingerprint, 'daemon-current');
  assert.equal(result?.artifacts?.web, undefined);
});

test('a waited activation request selects the new complete authority snapshot without rebuilding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-build-snapshot-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const producerStackBaseDir = join(root, 'producer');
  const consumerStackBaseDir = join(root, 'consumer');
  const selection = {
    components: { web: true, server: true, daemon: true },
    activateRuntime: true,
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-old' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-old',
    webArtifactFingerprint: 'web-old',
  });
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'daemon', fingerprint: 'daemon-old' });
  await writeRuntimeSnapshotLayout({
    stackDir: producerStackBaseDir,
    snapshotId: 'snapshot-old',
    sourceFingerprint: 'snapshot-old',
    source: { serverComponent: 'happier-server-light' },
    web: { artifactFingerprint: 'web-old' },
    server: { artifactFingerprint: 'server-old' },
    daemon: {
      artifactFingerprint: 'daemon-old',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });
  const baselineStoreState = {
    snapshotId: 'snapshot-old',
    artifactFingerprints: { web: 'web-old', server: 'server-old', daemon: 'daemon-old' },
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-new' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-new',
    webArtifactFingerprint: 'web-new',
  });
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'daemon', fingerprint: 'daemon-new' });
  const { snapshotDir } = await writeRuntimeSnapshotLayout({
    stackDir: producerStackBaseDir,
    snapshotId: 'snapshot-new',
    sourceFingerprint: 'snapshot-new',
    source: { serverComponent: 'happier-server-light' },
    web: { artifactFingerprint: 'web-new' },
    server: { artifactFingerprint: 'server-new' },
    daemon: {
      artifactFingerprint: 'daemon-new',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });

  const selections = [];
  const result = await resolveCompletedRuntimeBuildAfterWait({
    authority: {
      consumerStackName: 'agent-qa',
      consumerStackBaseDir,
      producerStackName: 'repo-producer',
      producerStackBaseDir,
    },
    selection,
    baselineStoreState,
    expectedArtifactFingerprints: {
      web: 'web-requested',
      server: 'server-requested',
      daemon: 'daemon-requested',
    },
    selectRuntimeSnapshotImpl: async (args) => {
      selections.push(args);
      return {
        snapshotId: args.snapshotId,
        snapshotPath: snapshotDir,
        currentPath: join(consumerStackBaseDir, 'runtime', 'current.json'),
      };
    },
  });

  assert.equal(result?.snapshotId, 'snapshot-new');
  assert.equal(result?.reused, true);
  assert.equal(result?.selected, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result?.artifacts ?? {}).map(([component, artifact]) => [
      component,
      artifact.manifest.artifactFingerprint,
    ])),
    { web: 'web-new', server: 'server-new', daemon: 'daemon-new' },
  );
  assert.deepEqual(selections, [{
    consumerStackBaseDir,
    producerStackBaseDir,
    producerStackName: 'repo-producer',
    snapshotId: 'snapshot-new',
  }]);

  const producerOnly = await resolveCompletedRuntimeBuildAfterWait({
    authority: {
      consumerStackName: 'agent-qa',
      consumerStackBaseDir,
      producerStackName: 'repo-producer',
      producerStackBaseDir,
    },
    selection,
    baselineStoreState,
    expectedArtifactFingerprints: {
      web: 'web-requested',
      server: 'server-requested',
      daemon: 'daemon-requested',
    },
    selectConsumer: false,
    selectRuntimeSnapshotImpl: async () => {
      throw new Error('producer-only publication must not select a consumer');
    },
  });
  assert.equal(producerOnly?.snapshotId, 'snapshot-new');
  assert.equal(producerOnly?.selected, false);
  assert.equal(producerOnly?.runtime?.selected, false);
});

test('a waited activation request does not select a snapshot that changed no requested component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-build-snapshot-mismatch-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const producerStackBaseDir = join(root, 'producer');
  const consumerStackBaseDir = join(root, 'consumer');
  const selection = {
    components: { web: false, server: true, daemon: true },
    activateRuntime: true,
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-old' });
  await publishArtifact({
    stackBaseDir: producerStackBaseDir,
    component: 'server',
    fingerprint: 'server-old',
    webArtifactFingerprint: 'web-old',
  });
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'daemon', fingerprint: 'daemon-old' });
  await writeRuntimeSnapshotLayout({
    stackDir: producerStackBaseDir,
    snapshotId: 'snapshot-old',
    sourceFingerprint: 'snapshot-old',
    source: { serverComponent: 'happier-server-light' },
    web: { artifactFingerprint: 'web-old' },
    server: { artifactFingerprint: 'server-old' },
    daemon: {
      artifactFingerprint: 'daemon-old',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });
  const baselineStoreState = {
    snapshotId: 'snapshot-old',
    artifactFingerprints: { web: 'web-old', server: 'server-old', daemon: 'daemon-old' },
  };
  await publishArtifact({ stackBaseDir: producerStackBaseDir, component: 'web', fingerprint: 'web-new' });
  await writeRuntimeSnapshotLayout({
    stackDir: producerStackBaseDir,
    snapshotId: 'snapshot-web-only',
    sourceFingerprint: 'snapshot-web-only',
    source: { serverComponent: 'happier-server-light' },
    web: { artifactFingerprint: 'web-new' },
    server: { artifactFingerprint: 'server-old' },
    daemon: {
      artifactFingerprint: 'daemon-old',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });

  assert.equal(
    await resolveCompletedRuntimeBuildAfterWait({
      authority: {
        consumerStackName: 'agent-qa',
        consumerStackBaseDir,
        producerStackName: 'repo-producer',
        producerStackBaseDir,
      },
      selection,
      baselineStoreState,
      expectedArtifactFingerprints: {
        server: 'server-requested',
        daemon: 'daemon-requested',
      },
      selectRuntimeSnapshotImpl: async () => {
        throw new Error('must not select an unrelated snapshot');
      },
    }),
    null,
  );
});
