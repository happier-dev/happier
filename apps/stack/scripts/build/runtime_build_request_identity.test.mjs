import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeArtifactFingerprint, readRuntimeComponentSourceFingerprint } from './runtime_artifact_identity.mjs';
import { resolveRuntimeBuildRequestIdentity } from './runtime_build_request_identity.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { readWorkspaceBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { captureBuildInputFiles } from '../../../../scripts/workspaces/buildInputConvergence.mjs';

test('daemon support identity ignores unshipped tests while retaining shipped resources and runtime source', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'runtime-daemon-test-membership-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps/cli');
  const packageDir = join(repoDir, 'packages/fixture');
  for (const dir of [cliDir, packageDir]) await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli',
    dependencies: { '@happier-dev/fixture': '0.0.0' }, bundledDependencies: ['@happier-dev/fixture'] }));
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/fixture',
    files: ['dist', 'resources/tests'] }));
  await mkdir(join(packageDir, 'resources/tests'), { recursive: true });
  await writeFile(join(packageDir, 'resources/tests/runtime.json'), '{"value":1}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const value = 1;');
  await writeFile(join(packageDir, 'src/ui.ts'), 'export const view = 1;');
  for (const app of ['ui', 'server']) {
    const hostDir = join(repoDir, 'apps', app);
    await mkdir(join(hostDir, 'sources'), { recursive: true });
    await writeFile(join(hostDir, 'package.json'), JSON.stringify({ name: `@happier-dev/${app}`,
      dependencies: { '@happier-dev/fixture': '0.0.0' } }));
    await writeFile(join(hostDir, 'sources/index.ts'), 'export const host = 1;');
  }
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  const fingerprint = () => Promise.all(['daemon', 'web', 'server'].map(component =>
    readRuntimeComponentSourceFingerprint({ component, sourceMetadata: { repoDir }, includeRuntimeSupportInputs: true })));
  const before = await fingerprint();
  for (const dir of [join(cliDir, 'src'), join(cliDir, 'scripts'), join(packageDir, 'src'),
    join(repoDir, 'apps/ui/sources'), join(repoDir, 'apps/server/sources'), join(repoDir, 'scripts/workspaces')]) {
    await mkdir(join(dir, 'testkit'), { recursive: true });
    await writeFile(join(dir, 'owner.test.ts'), 'test only');
    await writeFile(join(dir, 'owner.spec.tsx'), 'spec only');
    await writeFile(join(dir, 'owner.testkit.ts'), 'test support only');
    await writeFile(join(dir, 'owner.test-support.ts'), 'excluded compiler test support only');
    await writeFile(join(dir, 'testkit/fixture.ts'), 'fixture only');
    await mkdir(join(dir, '__snapshots__'), {recursive:true});
    await writeFile(join(dir, '__snapshots__/owner.spec.ts.snap'), 'test snapshot only');
  }
  assert.deepEqual(await fingerprint(), before, 'adding tests must not change component membership');
  await writeFile(join(cliDir, 'src/owner.test.ts'), 'changed test only');
  await writeFile(join(packageDir, 'src/owner.spec.tsx'), 'changed spec only');
  assert.deepEqual(await fingerprint(), before, 'test/spec-only edits must not invalidate component capture');
  assert.equal(readWorkspaceBuildInputs(packageDir).some(path => path.includes('testkit')), false,
    'inventory and runtime traversal share test membership');
  await writeFile(join(packageDir, 'src/ui.ts'), 'export const view = 2;');
  for (const [index, value] of (await fingerprint()).entries()) assert.notEqual(value, before[index], 'exported UI remains a support input');
  const runtimeChanged = await fingerprint();
  await writeFile(join(packageDir, 'resources/tests/runtime.json'), '{"value":2}');
  for (const [index, value] of (await fingerprint()).entries()) assert.notEqual(value, runtimeChanged[index], 'explicit shipped resources override test naming');
});

test('daemon support identity retains runtime inputs under test-named checkout parents and opaque host paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-host-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, 'tests', 'checkout');
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'codex/tests'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  await writeFile(join(cliDir, 'src/index.ts'), 'export const runtime = 1;');
  await writeFile(join(cliDir, 'codex/tests/runtime.cjs'), 'module.exports = 1;');
  const fingerprint = () => readRuntimeComponentSourceFingerprint({
    component: 'daemon', sourceMetadata: { repoDir }, includeRuntimeSupportInputs: true,
  });
  const before = await fingerprint();
  await writeFile(join(cliDir, 'src/index.ts'), 'export const runtime = 2;');
  const sourceChanged = await fingerprint();
  assert.notEqual(sourceChanged, before, 'checkout ancestor names must not exclude runtime source');
  await writeFile(join(cliDir, 'codex/tests/runtime.cjs'), 'module.exports = 2;');
  assert.notEqual(await fingerprint(), sourceChanged, 'opaque host support is not source-test membership');
});

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

test('relocated web and server inputs keep producer identity labels and still observe content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-relocated-inputs-'));
  try {
    const producer = join(root, 'producer');
    const worker = join(root, 'worker');
    for (const repo of [producer, worker]) for (const app of ['ui', 'server']) {
      await mkdir(join(repo, 'apps', app, 'sources'), { recursive: true });
      await writeFile(join(repo, 'apps', app, 'package.json'), JSON.stringify({ name: `@happier-dev/${app}` }));
      await writeFile(join(repo, 'apps', app, 'sources/index.ts'), 'same consumed bytes');
    }
    for (const component of ['web', 'server']) {
      const original = await readRuntimeComponentSourceFingerprint({ component, sourceMetadata: { repoDir: producer } });
      const relocated = await readRuntimeComponentSourceFingerprint({ component, sourceMetadata: { repoDir: worker }, identityRepoDir: producer });
      assert.equal(relocated, original);
      await writeFile(join(worker, 'apps', component === 'web' ? 'ui' : 'server', 'sources/index.ts'), 'changed bytes');
      assert.notEqual(await readRuntimeComponentSourceFingerprint({ component, sourceMetadata: { repoDir: worker }, identityRepoDir: producer }), original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every component identity separates consumer architectures', () => {
  for (const component of ['web', 'server', 'daemon']) {
    const input = { component, sourceMetadata, componentSourceFingerprint: 'same-source', supportArtifactFingerprint: 'same-support', platform: 'linux' };
    assert.notEqual(createRuntimeArtifactFingerprint({ ...input, arch: 'arm64' }), createRuntimeArtifactFingerprint({ ...input, arch: 'x64' }));
  }
});

test('explicit build targets determine request identity independently of the worker host', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'runtime-target-inputs-'));
  t.after(async () => await rm(repoDir, { recursive: true, force: true }));
  await mkdir(join(repoDir, 'apps', 'ui', 'sources'), { recursive: true });
  await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  await writeFile(join(repoDir, 'apps', 'ui', 'sources', 'index.ts'), 'export const value = 1;');
  const options = {
    rootDir: repoDir,
    selection: { components: { web: true, server: false, daemon: false }, activateRuntime: false },
    env: {}, sourceMetadata: { ...sourceMetadata, repoDir },
  };
  const arm = await resolveRuntimeBuildRequestIdentity({ ...options, target: { platform: 'linux', arch: 'arm64' } });
  const x64 = await resolveRuntimeBuildRequestIdentity({ ...options, target: { platform: 'linux', arch: 'x64' } });
  assert.equal(arm.componentSourceFingerprints.web, x64.componentSourceFingerprints.web);
  assert.notEqual(arm.artifactFingerprints.web, x64.artifactFingerprints.web);
  assert.equal(arm.artifactFingerprints.web, createRuntimeArtifactFingerprint({
    component: 'web', sourceMetadata: options.sourceMetadata,
    componentSourceFingerprint: arm.componentSourceFingerprints.web,
    toolchainInputs: [`node=${process.version}`], platform: 'linux', arch: 'arm64', env: {},
  }));
});

test('QA stale outputs give artifacts distinct identities even with identical current inputs', () => {
  const inputs = { component: 'web', sourceMetadata, componentSourceFingerprint: 'same-source' };
  const stalePackages = [{ packageName: '@happier-dev/example', outputIdentity: 'old-output' }];
  const stale = createRuntimeArtifactFingerprint({ ...inputs, stalePackages });
  assert.notEqual(stale, createRuntimeArtifactFingerprint(inputs));
  assert.notEqual(stale, createRuntimeArtifactFingerprint({ ...inputs, stalePackages: [{ ...stalePackages[0], outputIdentity: 'different-output' }] }));
  assert.equal(stale, createRuntimeArtifactFingerprint({ ...inputs, stalePackages: [{ ...stalePackages[0], diagnosticSummary: 'another failure' }] }));
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
  const target = { platform: 'linux', arch: 'arm64' };
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
    target,
    env,
    collectBuildSourceMetadataImpl: async () => sourceMetadata,
    collectRuntimeComponentSourceFingerprintsImpl: async () => componentSourceFingerprints,
    collectRuntimeBuildToolchainInputsImpl: async () => toolchainInputs,
    assertSelectedBuildPrerequisitesImpl: () => {},
    resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-a',
    resolveDaemonSupportArtifactFingerprintImpl: async () => 'daemon-support-a',
  });

  const web = createRuntimeArtifactFingerprint({
    ...target,
    component: 'web',
    sourceMetadata,
    componentSourceFingerprint: componentSourceFingerprints.web,
    toolchainInputs: toolchainInputs.web,
    env,
  });
  const server = createRuntimeArtifactFingerprint({
    ...target,
    component: 'server',
    sourceMetadata,
    componentSourceFingerprint: componentSourceFingerprints.server,
    supportArtifactFingerprint: 'server-support-a',
    toolchainInputs: toolchainInputs.server,
    env,
  });
  const daemon = createRuntimeArtifactFingerprint({
    ...target,
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
    createRuntimeSnapshotId({ sourceMetadata, componentFingerprints: { web, server, daemon }, ...target }),
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

test('workspace capture includes authored root declarations without admitting tests or generated outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-root-declarations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const captureDir = join(root, 'capture');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ files: ['dist'] }));
  const files = {
    'workspaceBundleLock.mjs': 'export const lock = true;',
    'workspaceBundleLock.d.mts': 'export declare const lock: boolean;',
    'cliDistBuildManifest.cjs': 'exports.manifest = true;',
    'cliDistBuildManifest.d.cts': 'export declare const manifest: boolean;',
    'runtime.js': 'exports.runtime = true;',
    'runtime.d.ts': 'export declare const runtime: boolean;',
    'src/index.ts': 'export const source = true;',
    'src/owner.test.ts': 'test only',
    'src/testkit/fixture.d.mts': 'test fixture only',
    'vitest.config.mjs': 'test config only',
    'test-setup.d.mts': 'test setup only',
    'tsconfig.test.json': '{}',
    'dist/generated.d.mts': 'generated output only',
    '.happier-plugin/api/generated.d.mts': 'generated plugin output only',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(sourceDir, path, '..'), { recursive: true });
    await writeFile(join(sourceDir, path), content);
  }
  const { files: captured } = await captureBuildInputFiles({ sourceDir, captureDir,
    readPaths: () => readWorkspaceBuildInputs(sourceDir, {
      includeShippedFiles: true, excludeGeneratedPluginArtifacts: true,
    }),
  });
  assert.deepEqual(captured, [
    'cliDistBuildManifest.cjs', 'cliDistBuildManifest.d.cts', 'package.json',
    'runtime.d.ts', 'runtime.js', 'src/index.ts',
    'workspaceBundleLock.d.mts', 'workspaceBundleLock.mjs',
  ]);
  for (const path of captured) assert.equal(await readFile(join(captureDir, path), 'utf8'),
    await readFile(join(sourceDir, path), 'utf8'));
});
