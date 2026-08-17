import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeArtifactFingerprint } from './runtime_artifact_identity.mjs';
import { resolveRuntimeBuildRequestIdentity } from './runtime_build_request_identity.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';

const sourceMetadata = Object.freeze({
  repoDir: '/repo',
  commitSha: 'commit-a',
  dirtyHash: 'dirty-a',
  serverComponent: 'happier-server-light',
  dbProvider: 'sqlite',
  sourceFingerprint: 'source-a',
  builtAt: '2026-08-16T12:00:00.000Z',
});

const toolchainInputs = Object.freeze({
  web: ['node=v22.22.1'],
  server: ['node=v22.22.1', 'bun=1.2.3'],
  daemon: ['node=v22.22.1', 'bun=1.2.3', 'yarn=1.22.22'],
});

const componentSourceFingerprints = Object.freeze({
  web: 'web-source-a',
  server: 'server-source-a',
  daemon: 'daemon-source-a',
});

test('component artifact recipes use only their consumed source, toolchain, and support identities', () => {
  const baseline = {
    web: createRuntimeArtifactFingerprint({
      component: 'web',
      sourceMetadata,
      componentSourceFingerprint: 'web-source-a',
      toolchainInputs: toolchainInputs.web,
    }),
    server: createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata,
      componentSourceFingerprint: 'server-code-a',
      supportArtifactFingerprint: 'server-support-a',
      toolchainInputs: toolchainInputs.server,
    }),
    daemon: createRuntimeArtifactFingerprint({
      component: 'daemon',
      sourceMetadata,
      componentSourceFingerprint: 'daemon-code-a',
      supportArtifactFingerprint: 'daemon-support-a',
      toolchainInputs: toolchainInputs.daemon,
    }),
  };
  const unrelatedCheckoutProvenance = {
    ...sourceMetadata,
    commitSha: 'another-commit',
    dirtyHash: 'other-agent-dirty-work',
    sourceFingerprint: 'whole-checkout-provenance-only',
  };

  assert.equal(
    createRuntimeArtifactFingerprint({
      component: 'web',
      sourceMetadata: unrelatedCheckoutProvenance,
      componentSourceFingerprint: 'web-source-a',
      toolchainInputs: toolchainInputs.web,
    }),
    baseline.web,
  );
  assert.equal(
    createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata: unrelatedCheckoutProvenance,
      componentSourceFingerprint: 'server-code-a',
      supportArtifactFingerprint: 'server-support-a',
      toolchainInputs: toolchainInputs.server,
    }),
    baseline.server,
  );
  assert.equal(
    createRuntimeArtifactFingerprint({
      component: 'daemon',
      sourceMetadata: unrelatedCheckoutProvenance,
      componentSourceFingerprint: 'daemon-code-a',
      supportArtifactFingerprint: 'daemon-support-a',
      toolchainInputs: toolchainInputs.daemon,
    }),
    baseline.daemon,
  );

  assert.notEqual(
    createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata,
      componentSourceFingerprint: 'server-code-b',
      supportArtifactFingerprint: 'server-support-a',
      toolchainInputs: toolchainInputs.server,
    }),
    baseline.server,
  );
  assert.notEqual(
    createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata,
      componentSourceFingerprint: 'server-code-a',
      supportArtifactFingerprint: 'server-support-b',
      toolchainInputs: toolchainInputs.server,
    }),
    baseline.server,
  );
  assert.notEqual(
    createRuntimeArtifactFingerprint({
      component: 'daemon',
      sourceMetadata,
      componentSourceFingerprint: 'daemon-code-b',
      supportArtifactFingerprint: 'daemon-support-a',
      toolchainInputs: toolchainInputs.daemon,
    }),
    baseline.daemon,
  );
  assert.notEqual(
    createRuntimeArtifactFingerprint({
      component: 'web',
      sourceMetadata,
      componentSourceFingerprint: 'web-source-b',
      toolchainInputs: toolchainInputs.web,
    }),
    baseline.web,
  );
  assert.equal(
    createRuntimeArtifactFingerprint({
      component: 'web',
      sourceMetadata,
      componentSourceFingerprint: 'web-source-a',
      toolchainInputs: toolchainInputs.web,
    }),
    baseline.web,
  );
});

test('build request identity matches the exact all-component artifact recipe and snapshot', async () => {
  const selection = {
    components: { web: true, server: true, daemon: true },
    activateRuntime: true,
  };
  const env = {
    PATH: process.env.PATH,
    HAPPIER_BUN_PATH: '/toolchain/bun',
    HAPPIER_SERVER_BUN_EXTERNALS: 'external-a,external-b',
    HAPPIER_CLI_BUN_EXTERNALS: 'external-c',
  };
  const result = await resolveRuntimeBuildRequestIdentity({
    rootDir: '/repo',
    producerStackBaseDir: '/stacks/producer',
    selection,
    env,
    collectBuildSourceMetadataImpl: async () => sourceMetadata,
    collectRuntimeComponentSourceFingerprintsImpl: async () => componentSourceFingerprints,
    collectRuntimeBuildToolchainInputsImpl: async () => toolchainInputs,
    assertSelectedBuildPrerequisitesImpl: () => {},
    resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-a',
    resolveDaemonSupportArtifactFingerprintImpl: async () => 'daemon-support-a',
  });

  const web = createRuntimeArtifactFingerprint({
    component: 'web',
    sourceMetadata,
    componentSourceFingerprint: componentSourceFingerprints.web,
    toolchainInputs: toolchainInputs.web,
    env,
  });
  const server = createRuntimeArtifactFingerprint({
    component: 'server',
    sourceMetadata,
    componentSourceFingerprint: componentSourceFingerprints.server,
    supportArtifactFingerprint: 'server-support-a',
    toolchainInputs: toolchainInputs.server,
    env,
  });
  const daemon = createRuntimeArtifactFingerprint({
    component: 'daemon',
    sourceMetadata,
    componentSourceFingerprint: componentSourceFingerprints.daemon,
    supportArtifactFingerprint: 'daemon-support-a',
    toolchainInputs: toolchainInputs.daemon,
    env,
  });

  assert.deepEqual(result.artifactFingerprints, { web, server, daemon });
  assert.equal(
    result.snapshotId,
    createRuntimeSnapshotId({ sourceMetadata, componentFingerprints: { web, server, daemon } }),
  );
});

test('server-only request identity has no web artifact dependency', async () => {
  const selection = {
    components: { web: false, server: true, daemon: false },
    activateRuntime: false,
  };
  const env = { PATH: process.env.PATH, HAPPIER_BUN_PATH: '/toolchain/bun' };
  const result = await resolveRuntimeBuildRequestIdentity({
    rootDir: '/repo',
    producerStackBaseDir: '/stacks/producer',
    selection,
    env,
    collectBuildSourceMetadataImpl: async () => sourceMetadata,
    collectRuntimeComponentSourceFingerprintsImpl: async () => ({ server: componentSourceFingerprints.server }),
    collectRuntimeBuildToolchainInputsImpl: async () => toolchainInputs,
    assertSelectedBuildPrerequisitesImpl: () => {},
    resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-a',
    resolveDaemonSupportArtifactFingerprintImpl: async () => {
      throw new Error('server-only request must not resolve daemon support');
    },
  });

  assert.deepEqual(result.artifactFingerprints, {
    server: createRuntimeArtifactFingerprint({
      component: 'server',
      sourceMetadata,
      componentSourceFingerprint: componentSourceFingerprints.server,
      supportArtifactFingerprint: 'server-support-a',
      toolchainInputs: toolchainInputs.server,
      env,
    }),
  });
  assert.equal(result.snapshotId, null);
});
