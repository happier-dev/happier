import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

import * as buildModule from './build_stack_artifacts.mjs';
import { createRuntimeArtifactFingerprint, resolveRuntimeComponentSourcePaths } from './runtime_artifact_identity.mjs';

test('server artifact identity includes a workspace dependency build script', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'happier-server-identity-inputs-'));
  try {
    const serverDir = join(repoDir, 'apps', 'server');
    const protocolDir = join(repoDir, 'packages', 'protocol');
    mkdirSync(join(protocolDir, 'scripts'), { recursive: true });
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/server',
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }));
    writeFileSync(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol' }));
    writeFileSync(join(protocolDir, 'scripts', 'generate.mjs'), 'export const policy = true;\n');
    assert.ok(resolveRuntimeComponentSourcePaths({
      component: 'server',
      sourceMetadata: { repoDir },
    }).includes(join(protocolDir, 'scripts')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
import { resolveRuntimeBuildRequestIdentity } from './runtime_build_request_identity.mjs';
import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { writeManagedRuntimeSnapshotLayout } from '../testkit/core/runtime_snapshot_layout.mjs';
import { selectRuntimeSnapshot, selectActiveProducerRuntimeSnapshot } from './activate_runtime_snapshot.mjs';

// Fixture repositories have no executor installation. Replace only the OS spawn
// boundary; the admitted controller, canonical builder and artifact store stay real.
const localRuntimeBuildTransport = {
  spawnController(_command, args, options) {
    assert.ok(args.includes('--local'));
    const workerEntry = fileURLToPath(new URL('./remote_runtime_build.mjs', import.meta.url));
    return spawn(process.execPath, [workerEntry, '--worker-request=stdin', args.find(arg => arg.startsWith('--artifact-target='))], {
      ...options, env: { ...options.env, HAPPIER_RUNTIME_BUILD_WORKER_NAME: 'local' },
    });
  },
};

test('a native service subset publishes without requiring or selecting a complete producer snapshot', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-native-subset-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.path('producer') };
  const layout = await writeManagedRuntimeSnapshotLayout({ stackDir: authority.producerStackBaseDir, snapshotId: 'compiler-output' });
  const artifactDir = fixture.path('producer', 'artifacts', 'daemon', 'daemon-compiler-output');
  const manifest = JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8'));
  rmSync(layout.snapshotDir, { recursive: true });
  const result = await buildModule.publishBuiltRepositoryRuntimeSnapshot({
    authority, selection: { components: { daemon: true }, publicationRequiredComponents: ['daemon'] }, requestedComponents: ['daemon'],
    sourceMetadata: { repoDir: fixture.path('repo'), sourceFingerprint: 'managed-source' },
    artifacts: { daemon: { artifactDir, manifest } }, env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.root },
    retentionPolicy: { artifactKeepCount: 2, runtimeSnapshotKeepCount: 2 },
  });
  const published = JSON.parse(readFileSync(join(result.snapshotPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(published.components), ['daemon']);
  assert.equal(existsSync(fixture.path('producer', 'runtime', 'current.json')), false,
    'a native subset cannot replace the complete producer runtime pin');
  const selected = await selectActiveProducerRuntimeSnapshot({ ...authority,
    consumerStackBaseDir: fixture.path('consumer'), requiredComponents: ['daemon'] });
  assert.equal(selected.snapshotId, result.snapshotId);
});

test('publication without activation preserves every stack selection even with a complete native snapshot', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-publication-no-selection-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.path('producer') };
  const old = await writeManagedRuntimeSnapshotLayout({ stackDir: authority.producerStackBaseDir, snapshotId: 'old' });
  await selectRuntimeSnapshot({ ...authority, consumerStackBaseDir: authority.producerStackBaseDir, snapshotId: old.snapshotId });
  const pointerPath = fixture.path('producer', 'runtime', 'current.json');
  const pointer = readFileSync(pointerPath, 'utf8');
  const layout = await writeManagedRuntimeSnapshotLayout({ stackDir: authority.producerStackBaseDir, snapshotId: 'new' });
  const artifacts = Object.fromEntries(['web', 'server', 'daemon'].map(component => {
    const artifactDir = fixture.path('producer', 'artifacts', component, `${component}-new`);
    return [component, { artifactDir, manifest: JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8')) }];
  }));
  const result = await buildModule.publishBuiltRepositoryRuntimeSnapshot({ authority,
    selection: { components: { daemon: true }, activateRuntime: false }, requestedComponents: ['daemon'],
    sourceMetadata: layout.manifest?.source ?? { sourceFingerprint: 'captured' }, artifacts,
    env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.root },
    retentionPolicy: { artifactKeepCount: 4, runtimeSnapshotKeepCount: 4 },
  });
  assert.ok(result.snapshotId);
  assert.equal(result.selected, false);
  assert.equal(readFileSync(pointerPath, 'utf8'), pointer);
});

test('a component publication composes a complete selectable snapshot while preserving stack selections', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-snapshot-currency-' });
  const repoDir = fixture.path('repo');
  const rootDir = join(repoDir, 'apps', 'stack');
  mkdirSync(join(repoDir, 'apps', 'ui', 'sources'), { recursive: true });
  writeFileSync(join(repoDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  writeFileSync(join(repoDir, 'apps', 'ui', 'sources', 'index.ts'), 'export const value = 1;');
  const authority = {
    producerStackName: 'producer', producerStackBaseDir: fixture.path('stacks', 'producer'),
    consumerStackName: 'qa', consumerStackBaseDir: fixture.path('stacks', 'qa'),
  };
  const env = { ...process.env, HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_RUNTIME_BUILD_KEEP: '4' };
  const old = await writeManagedRuntimeSnapshotLayout({ stackDir: authority.producerStackBaseDir, snapshotId: 'old' });
  await selectRuntimeSnapshot({ ...authority, consumerStackBaseDir: authority.producerStackBaseDir, snapshotId: old.snapshotId });
  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  const selection = { components: { web: true }, activateRuntime: false };
  const identity = await resolveRuntimeBuildRequestIdentity({ rootDir, selection, sourceMetadata, env });
  const artifactDir = join(authority.producerStackBaseDir, 'artifacts', 'web', identity.artifactFingerprints.web);
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>new web</html>');
  const stalePackages = [{ packageName: '@happier-dev/example', outputIdentity: 'last-green', diagnosticSummary: 'error TS2322' }];
  const typeWarnings = [{ packageName: '@happier-dev/cli', diagnosticSummary: 'error TS2345', reason: 'typecheck' }];
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({ version: 1, component: 'web',
    artifactFingerprint: identity.artifactFingerprints.web, sourceFingerprint: sourceMetadata.sourceFingerprint,
    payloadDir: 'payload', entrypoint: 'index.html', stalePackages }));
  const daemonManifestPath = join(authority.producerStackBaseDir, 'artifacts', 'daemon', 'daemon-old', 'manifest.json');
  const daemonManifest = JSON.parse(readFileSync(daemonManifestPath, 'utf8'));
  writeFileSync(daemonManifestPath, JSON.stringify({ ...daemonManifest, stalePackages: typeWarnings }));

  const publish = () => buildModule.publishBuiltRepositoryRuntimeSnapshot({ authority, selection,
    requestedComponents: ['web'], sourceMetadata,
    artifacts: { web: { artifactDir, manifest: JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8')) } },
    env, retentionPolicy: { artifactKeepCount: 4, runtimeSnapshotKeepCount: 4 },
  });
  const result = await publish();
  assert.ok(result.snapshotId, 'every successful component build must return its complete snapshot');
  assert.notEqual(result.snapshotId, old.snapshotId);
  assert.equal(result.selected, false);
  assert.equal(existsSync(join(authority.consumerStackBaseDir, 'runtime', 'current.json')), false);
  const pointer = JSON.parse(readFileSync(join(authority.producerStackBaseDir, 'runtime', 'current.json'), 'utf8'));
  assert.equal(pointer.snapshotId, old.snapshotId);
  const manifest = JSON.parse(readFileSync(join(result.snapshotPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.components.web.artifactFingerprint, identity.artifactFingerprints.web);
  assert.equal(manifest.components.server.artifactFingerprint, 'server-old');
  assert.equal(manifest.components.daemon.artifactFingerprint, 'daemon-old');
  assert.deepEqual(manifest.components.web.stalePackages, stalePackages);
  assert.deepEqual(manifest.components.daemon.stalePackages, typeWarnings);
  const repeated = await publish();
  assert.equal(repeated.snapshotId, result.snapshotId, 'unchanged component outputs reuse their complete snapshot');
  const selected = await selectActiveProducerRuntimeSnapshot({ ...authority });
  assert.equal(selected.snapshotId, result.snapshotId);
  // A real invalid-output failure preserves the previously selected runtime.
  const pointerBeforeFailure = readFileSync(join(authority.producerStackBaseDir, 'runtime', 'current.json'), 'utf8');
  rmSync(join(artifactDir, 'payload', 'index.html'));
  await assert.rejects(publish());
  assert.equal(readFileSync(join(authority.producerStackBaseDir, 'runtime', 'current.json'), 'utf8'), pointerBeforeFailure);
});

test('matching component inputs reuse artifacts before preparation, while missing outputs and source changes prepare', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'runtime-build-warm-inputs-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  const uiDir = join(repoDir, 'apps', 'ui');
  mkdirSync(join(uiDir, 'sources'), { recursive: true });
  writeFileSync(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  writeFileSync(join(uiDir, 'sources', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoDir, 'yarn.lock'), 'initial dependencies');
  const producerPaths = [
    join(repoDir, 'apps', 'cli', 'scripts', 'build-owned', 'generateBundledPluginEntries.ts'),
    join(repoDir, 'apps', 'cli', 'scripts', 'build-owned', 'bundledPlugins', 'registry.ts'),
    join(repoDir, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs'),
    join(uiDir, 'scripts', 'generateBundledPluginUiArtifacts.mjs'),
    join(repoDir, 'scripts', 'workspaces', 'bundledPluginPublicationFailure.mjs'),
    ...['sourceModule', 'bundleDaemonRuntime', 'runtimeStagingSource', 'daemonOutputManifest'].map((name) =>
      join(repoDir, 'apps', 'cli', 'src', 'plugins', 'authoring', `${name}.ts`)),
    join(repoDir, 'apps', 'cli', 'src', 'plugins', 'manifest', 'serialize.ts'),
  ];
  for (const path of producerPaths) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'export const producer = 1;\n');
  }
  const sourceModulePath = join(repoDir, 'apps', 'cli', 'src', 'plugins', 'authoring', 'sourceModule.ts');
  const transitivePath = join(sourceModulePath, '..', 'authoringDependency.ts');
  const cliDir = join(repoDir, 'apps', 'cli');
  writeFileSync(join(cliDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
  }));
  const generatedPaths = [
    join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    join(cliDir, 'src/prompts/assets/generated/pluginDescriptors.ts'),
  ];
  const regenerateLeaves = () => {
    for (const path of generatedPaths) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'export const generated = 1;\n');
    }
  };
  regenerateLeaves();
  const sourceModuleContent = [
    "import './authoringDependency.ts';",
    "import '../projection/registry/sources/generatedBundledPluginManifests.ts';",
    "import '@/plugins/projection/registry/sources/generatedBundledPlugins';",
    "import '../../prompts/assets/generated/pluginDescriptors';",
    'export const producer = 1;',
    '',
  ].join('\n');
  writeFileSync(sourceModulePath, sourceModuleContent);
  writeFileSync(transitivePath, 'export const dependency = 1;\n');
  const rootDir = join(repoDir, 'apps', 'stack');
  const stackBaseDir = join(repoDir, 'producer');
  const env = { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir };
  const selection = { components: { web: true, server: false, daemon: false }, activateRuntime: false, forceRebuild: false };
  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  const identity = await resolveRuntimeBuildRequestIdentity({ rootDir, selection, sourceMetadata, env });
  const artifactDir = join(stackBaseDir, 'artifacts', 'web', identity.artifactFingerprints.web);
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), 'last green');
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({
    version: 1, component: 'web', artifactFingerprint: identity.artifactFingerprints.web,
    sourceFingerprint: sourceMetadata.sourceFingerprint, payloadDir: 'payload', entrypoint: 'index.html',
  }));
  // The preparation callback is the compiler/publisher process boundary.
  // Identity resolution, artifact validation and the real web builder stay real.
  const options = {
    rootDir, stackBaseDir, selection, env,
    prepareBundledPluginPublicationInputsImpl: async () => { throw new Error('compiler boundary invoked'); },
  };
  const result = await buildModule.buildRuntimeArtifactComponents(options);
  assert.equal(result.artifacts.web.artifactDir, artifactDir);
  mkdirSync(join(repoDir, 'docs'));
  writeFileSync(join(repoDir, 'docs', 'unrelated.md'), 'unrelated edit');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  for (const path of generatedPaths) writeFileSync(path, 'export const generated = 2;\n');
  assert.equal((await resolveRuntimeBuildRequestIdentity({ rootDir, selection, sourceMetadata, env }))
    .artifactFingerprints.web, identity.artifactFingerprints.web, 'excluded generated bytes must not affect admission');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  for (const path of generatedPaths) rmSync(path);
  assert.equal((await resolveRuntimeBuildRequestIdentity({ rootDir, selection, sourceMetadata, env }))
    .artifactFingerprints.web, identity.artifactFingerprints.web, 'missing excluded leaves must not prevent identity capture');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  await assert.rejects(buildModule.buildRuntimeArtifactComponents({ ...options,
    selection: { ...selection, forceRebuild: true },
    prepareBundledPluginPublicationInputsImpl: async () => {
      regenerateLeaves();
      throw new Error('regenerated at compiler boundary');
    },
  }), /regenerated at compiler boundary/);
  for (const path of generatedPaths) assert.equal(readFileSync(path, 'utf8'), 'export const generated = 1;\n');
  const manifestPath = join(artifactDir, 'manifest.json');
  const manifestContent = readFileSync(manifestPath, 'utf8');
  rmSync(manifestPath);
  for (const path of generatedPaths) rmSync(path);
  const recovered = await buildModule.buildRuntimeArtifactComponents({ ...options,
    prepareBundledPluginPublicationInputsImpl: async () => {
      regenerateLeaves();
      writeFileSync(manifestPath, manifestContent);
    },
  });
  assert.equal(recovered.artifacts.web.artifactDir, artifactDir, 'cold preparation regenerates leaves before final identity capture');
  for (const path of generatedPaths) assert.equal(readFileSync(path, 'utf8'), 'export const generated = 1;\n');
  for (const path of generatedPaths) writeFileSync(path, 'export const = invalid generated output;\n');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  regenerateLeaves();
  writeFileSync(sourceModulePath, 'export const = invalid authored source;\n');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /Expected identifier/);
  writeFileSync(sourceModulePath, sourceModuleContent);
  rmSync(transitivePath);
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /Could not resolve/);
  writeFileSync(transitivePath, 'export const dependency = 1;\n');
  for (const path of producerPaths) {
    const originalContent = readFileSync(path, 'utf8');
    writeFileSync(path, 'export const producer = 2;\n');
    await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
    writeFileSync(path, originalContent);
    rmSync(path);
    await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
    writeFileSync(path, originalContent);
  }
  writeFileSync(transitivePath, 'export const dependency = 2;\n');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  writeFileSync(transitivePath, 'export const dependency = 1;\n');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<script src="chunk.js"></script>');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  writeFileSync(join(artifactDir, 'payload', 'chunk.js'), 'bundle');
  assert.equal((await buildModule.buildRuntimeArtifactComponents(options)).artifacts.web.artifactDir, artifactDir);
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  writeFileSync(join(artifactDir, 'payload', 'index.html'), 'last green');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents({ ...options,
    selection: { ...selection, forceRebuild: true },
  }), /compiler boundary invoked/);
  rmSync(join(artifactDir, 'payload', 'index.html'));
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  writeFileSync(join(artifactDir, 'payload', 'index.html'), 'last green');
  writeFileSync(join(repoDir, 'yarn.lock'), 'changed dependencies');
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  writeFileSync(join(repoDir, 'yarn.lock'), 'initial dependencies');
  rmSync(join(uiDir, 'sources', 'index.ts'));
  await assert.rejects(buildModule.buildRuntimeArtifactComponents(options), /compiler boundary invoked/);
  let preparedArtifactDir;
  const prepared = await buildModule.buildRuntimeArtifactComponents({ ...options,
    prepareBundledPluginPublicationInputsImpl: async () => {
      writeFileSync(join(uiDir, 'sources', 'index.ts'), 'export const value = 2;\n');
      const metadata = await collectBuildSourceMetadata({ rootDir, env });
      const finalIdentity = await resolveRuntimeBuildRequestIdentity({ rootDir, selection, sourceMetadata: metadata, env });
      preparedArtifactDir = join(stackBaseDir, 'artifacts', 'web', finalIdentity.artifactFingerprints.web);
      mkdirSync(join(preparedArtifactDir, 'payload'), { recursive: true });
      writeFileSync(join(preparedArtifactDir, 'payload', 'index.html'), 'prepared projection');
      writeFileSync(join(preparedArtifactDir, 'manifest.json'), JSON.stringify({
        version: 1, component: 'web', artifactFingerprint: finalIdentity.artifactFingerprints.web,
        sourceFingerprint: metadata.sourceFingerprint, payloadDir: 'payload', entrypoint: 'index.html',
      }));
    },
  });
  assert.equal(prepared.artifacts.web.artifactDir, preparedArtifactDir, 'preparation writes must recapture the final identity');
  assert.notEqual(preparedArtifactDir, artifactDir);
});

test('a failed explicit daemon build records its terminal error in the producer runtime state', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'happier-daemon-publication-error-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  const stackBaseDir = join(repoDir, 'producer');
  mkdirSync(stackBaseDir, { recursive: true });
  const statePath = join(stackBaseDir, 'stack.runtime.json');
  writeFileSync(statePath, JSON.stringify({
    runtimePublication: {
      phase: 'stale',
      components: { server: { phase: 'current', error: null }, daemon: { phase: 'stale', error: null } },
    },
  }));
  let failure;
  try {
    // An absent source tree is a real preparation failure, before artifact locks.
    await buildModule.buildStackArtifacts({
      rootDir: repoDir,
      argv: ['--daemon'],
      runtimeBuildTransport: localRuntimeBuildTransport,
      env: { ...process.env, HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_REPO_DIR: repoDir },
      authority: {
        producerStackName: 'producer', producerStackBaseDir: stackBaseDir,
        consumerStackName: 'qa', consumerStackBaseDir: join(repoDir, 'qa'),
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, 'the missing source tree must fail preparation');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.runtimePublication.components.daemon, { phase: 'failed', error: failure.message });
  assert.deepEqual(state.runtimePublication.components.server, { phase: 'current', error: null });
  assert.equal(state.runtimePublication.phase, 'failed');
});

test('runtime artifact identity inputs include only the toolchains consumed by each component', async () => {
  assert.equal(typeof buildModule.collectRuntimeBuildToolchainInputs, 'function');
  const calls = [];
  const inputs = await buildModule.collectRuntimeBuildToolchainInputs({
    selection: {
      components: { web: true, server: true, daemon: true },
    },
    env: { HAPPIER_BUN_PATH: '/toolchain/bun' },
    commandProbe: (command) => command === 'corepack',
    resolveBunCommandImpl: () => '/toolchain/bun',
    resolveYarnCommandImpl: () => ({ cmd: 'corepack', args: ['yarn'] }),
    runCaptureImpl: async (command, args) => {
      calls.push([command, args]);
      return command === '/toolchain/bun' ? '1.2.3\n' : '1.22.22\n';
    },
    nodeVersion: 'v22.22.1',
  });

  assert.deepEqual(inputs, {
    web: ['node=v22.22.1'],
    server: ['node=v22.22.1', 'bun=1.2.3'],
    daemon: ['node=v22.22.1', 'bun=1.2.3', 'yarn=1.22.22'],
  });
  assert.deepEqual(calls, [
    ['/toolchain/bun', ['--version']],
    ['corepack', ['yarn', '--version']],
  ]);

  const webOnly = await buildModule.collectRuntimeBuildToolchainInputs({
    selection: {
      components: { web: true, server: false, daemon: false },
    },
    runCaptureImpl: async () => {
      throw new Error('web-only builds must not probe Bun or Yarn');
    },
    nodeVersion: 'v22.22.1',
  });
  assert.deepEqual(webOnly, {
    web: ['node=v22.22.1'],
    server: [],
    daemon: [],
  });

  const serverOnly = await buildModule.collectRuntimeBuildToolchainInputs({
    selection: {
      components: { web: false, server: true, daemon: false },
    },
    commandProbe: (command) => command === 'bun',
    resolveBunCommandImpl: () => '/toolchain/bun',
    runCaptureImpl: async () => '1.2.3\n',
    nodeVersion: 'v22.22.1',
  });
  assert.deepEqual(serverOnly, {
    web: [],
    server: ['node=v22.22.1', 'bun=1.2.3'],
    daemon: [],
  });
});

test('server-only builds do not create or consume a web artifact', async () => {
  assert.equal(typeof buildModule.buildSelectedStackArtifacts, 'function');
  const calls = [];
  const artifacts = await buildModule.buildSelectedStackArtifacts({
    selection: {
      components: { web: false, server: true, daemon: false },
    },
    stackBaseDir: '/published/artifacts',
    buildComponent: async (component, _builder, options = {}) => {
      calls.push({ component, options });
      return {
        artifactDir: `/fresh/${component}-artifact`,
        manifest: { artifactFingerprint: `fresh-${component}` },
      };
    },
  });

  assert.deepEqual(calls, [{ component: 'server', options: {} }]);
  assert.deepEqual(Object.keys(artifacts), ['server']);
});

test('server-only publication does not require a CLI or UI plugin source tree', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'happier-server-only-preflight-'));
  try {
    mkdirSync(join(repoDir, 'apps', 'server'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(repoDir, 'apps', 'server', 'package.json'), JSON.stringify({
      name: '@happier-dev/server',
    }));
    await buildModule.prepareBundledPluginPublicationInputs({
      rootDir: repoDir,
      env: { HAPPIER_STACK_REPO_DIR: repoDir },
      selection: { components: { web: false, server: true, daemon: false } },
    });
    assert.deepEqual(readdirSync(repoDir).sort(), ['apps', 'package.json']);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('selected components build in a simple serial owner-local order without server-web coupling', async () => {
  assert.equal(typeof buildModule.buildSelectedStackArtifacts, 'function');
  const calls = [];

  const artifacts = await buildModule.buildSelectedStackArtifacts({
    selection: {
      components: { web: true, server: true, daemon: true },
    },
    stackBaseDir: '/published/artifacts',
    buildComponent: async (component, _builder, options = {}) => {
      calls.push({ component, options });
      return {
        artifactDir: `/fresh/${component}-artifact`,
        manifest: { artifactFingerprint: `fresh-${component}` },
      };
    },
  });

  assert.deepEqual(calls, [
    { component: 'web', options: {} },
    { component: 'server', options: {} },
    { component: 'daemon', options: {} },
  ]);
  assert.deepEqual(Object.keys(artifacts), ['web', 'server', 'daemon']);
});

test('assertSelectedBuildPrerequisites does not require bun for web-only builds', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.doesNotThrow(() =>
    buildModule.assertSelectedBuildPrerequisites({
      selection: {
        components: {
          web: true,
          server: false,
          daemon: false,
        },
      },
      commandProbe: () => false,
    }),
  );
});

test('assertSelectedBuildPrerequisites fails fast when server artifacts need bun', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: true,
            daemon: false,
          },
        },
        commandProbe: () => false,
        env: {
          HOME: '/definitely-missing-home',
          BUN_INSTALL: '',
          USERPROFILE: '',
        },
      }),
    /bun.*required.*server/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast for activate-runtime builds before web export starts', () => {
    assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
    assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: true,
            server: true,
            daemon: true,
          },
        },
        commandProbe: () => false,
        env: {
          HOME: '/definitely-missing-home',
          BUN_INSTALL: '',
          USERPROFILE: '',
        },
      }),
    /bun.*server and daemon/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast when daemon artifacts need yarn or corepack', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: false,
            daemon: true,
          },
        },
        commandProbe: (cmd) => cmd === 'bun',
      }),
    /yarn or corepack/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast when daemon support needs Go', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: false,
            daemon: true,
          },
        },
        commandProbe: (cmd) => cmd === 'bun' || cmd === 'yarn',
      }),
    /go.*required.*daemon support/i,
  );
});

test('assertSelectedBuildPrerequisites accepts bun from BUN_INSTALL even when PATH probe misses it', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  const tempRoot = mkdtempSync(join(tmpdir(), 'stack-build-prereq-bun-'));
  try {
    const bunInstallDir = join(tempRoot, '.bun');
    const bunBinDir = join(bunInstallDir, 'bin');
    const bunPath = join(bunBinDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
    mkdirSync(bunBinDir, { recursive: true });
    writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
      mode: 0o755,
    });

    assert.doesNotThrow(() =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: true,
            daemon: false,
          },
        },
        commandProbe: () => false,
        env: {
          BUN_INSTALL: bunInstallDir,
        },
      }),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the artifact coordinator probes source identity before preparation and recaptures final publication identity', async () => {
  assert.equal(typeof buildModule.buildRuntimeArtifactComponents, 'function');
  const events = [];
  let identityReads = 0;
  const preparedWorkspacePublication = {
    workspaceRuntimeIdentity: 'a'.repeat(64),
    workspaceRuntimePackages: ['@happier-dev/protocol'],
  };
  const stackBaseDir = '/stacks/repository-producer';
  const fixtureRepoRoot = mkdtempSync(join(tmpdir(), 'runtime-build-preidentity-publication-'));
  const fixtureStackRoot = join(fixtureRepoRoot, 'apps', 'stack');
  mkdirSync(fixtureStackRoot, { recursive: true });
  const installedWorkspacePath = join(
    fixtureRepoRoot,
    'apps',
    'cli',
    'node_modules',
    '@happier-dev',
    'protocol',
    'dist',
    'identity.txt',
  );
  mkdirSync(join(installedWorkspacePath, '..'), { recursive: true });
  writeFileSync(installedWorkspacePath, 'stale', 'utf8');

  try {
    const result = await buildModule.buildRuntimeArtifactComponents({
      rootDir: fixtureStackRoot,
      stackBaseDir,
      selection: {
        components: { web: false, server: true, daemon: true },
        activateRuntime: false,
        forceRebuild: false,
      },
      env: {},
      assertSelectedBuildPrerequisitesImpl: () => {},
      prepareBundledPluginPublicationInputsImpl: async () => {
        writeFileSync(installedWorkspacePath, 'settled', 'utf8');
      },
      readCliBinaryArtifactWorkspacePublicationImpl: async ({ repoRoot }) => {
        assert.equal(repoRoot, fixtureRepoRoot);
        events.push('daemon-workspace-publication');
        return preparedWorkspacePublication;
      },
      collectBuildSourceMetadataImpl: async ({ rootDir }) => {
        assert.equal(rootDir, fixtureStackRoot);
        events.push('source-metadata');
        return {
          repoDir: fixtureRepoRoot,
          sourceFingerprint: 'provenance-a',
          builtAt: '2026-08-16T12:00:00.000Z',
          serverComponent: 'happier-server-light',
          dbProvider: 'sqlite',
        };
      },
      resolveRuntimeBuildRequestIdentityImpl: async () => {
        assert.equal(readFileSync(installedWorkspacePath, 'utf8'), identityReads++ === 0 ? 'stale' : 'settled');
        events.push('build-request-identity');
        return {
          sourceMetadata: {
            repoDir: fixtureRepoRoot,
            sourceFingerprint: 'provenance-a',
            builtAt: '2026-08-16T12:00:00.000Z',
            serverComponent: 'happier-server-light',
            dbProvider: 'sqlite',
          },
          artifactFingerprints: { server: 'server-code-a', daemon: 'daemon-code-a' },
          componentSourceFingerprints: { daemon: 'a'.repeat(64) },
          supportArtifactFingerprints: { server: 'server-support-a', daemon: 'daemon-support-a' },
        };
      },
      buildSelectedStackArtifactsImpl: async ({ buildComponent }) => ({
        server: await buildComponent('server', async (input) => {
          assert.deepEqual(events, [
            'source-metadata',
            'build-request-identity',
            'source-metadata',
            'build-request-identity',
          ]);
          assert.equal(input.supportArtifactFingerprint, 'server-support-a');
          events.push('server-payload');
          return {
            artifactDir: '/stacks/repository-producer/artifacts/server/server-code-a',
            manifest: {
              component: 'server',
              artifactFingerprint: 'server-code-a',
              serverSupportArtifactFingerprint: 'server-support-a',
            },
          };
        }),
        daemon: await buildComponent('daemon', async (input) => {
          assert.deepEqual(events, [
            'source-metadata',
            'build-request-identity',
            'source-metadata',
            'build-request-identity',
            'server-payload',
            'daemon-workspace-publication',
          ]);
          assert.equal(input.supportArtifactFingerprint, 'daemon-support-a');
          assert.equal(input.requiredCliDistInputFingerprint, 'a'.repeat(64));
          assert.equal(input.preparedWorkspacePublication, preparedWorkspacePublication);
          events.push('daemon-payload');
          return {
            artifactDir: '/stacks/repository-producer/artifacts/daemon/daemon-code-a',
            manifest: {
              component: 'daemon',
              artifactFingerprint: 'daemon-code-a',
              daemonSupportArtifactFingerprint: 'daemon-support-a',
            },
          };
        }),
      }),
    });

    assert.deepEqual(events, [
      'source-metadata',
      'build-request-identity',
      'source-metadata',
      'build-request-identity',
      'server-payload',
      'daemon-workspace-publication',
      'daemon-payload',
    ]);
    assert.equal(readFileSync(installedWorkspacePath, 'utf8'), 'settled');
    assert.equal(result.artifacts.server.manifest.artifactFingerprint, 'server-code-a');
    assert.equal(result.artifacts.daemon.manifest.artifactFingerprint, 'daemon-code-a');
  } finally {
    rmSync(fixtureRepoRoot, { recursive: true, force: true });
  }
});

test('web-only artifact builds never prepare the CLI bundled workspace closure', async () => {
  assert.equal(typeof buildModule.buildRuntimeArtifactComponents, 'function');
  let workspacePreparationCalls = 0;
  const result = await buildModule.buildRuntimeArtifactComponents({
    rootDir: '/repo/apps/stack',
    stackBaseDir: '/stacks/repository-producer',
    selection: {
      components: { web: true, server: false, daemon: false },
      activateRuntime: false,
      forceRebuild: false,
    },
    env: {},
    assertSelectedBuildPrerequisitesImpl: () => {},
    prepareBundledPluginPublicationInputsImpl: async () => {},
    readCliBinaryArtifactWorkspacePublicationImpl: async () => {
      workspacePreparationCalls += 1;
      throw new Error('web-only artifact builds must not prepare CLI workspaces');
    },
    collectBuildSourceMetadataImpl: async () => ({
      repoDir: '/repo',
      sourceFingerprint: 'provenance-a',
      builtAt: '2026-08-16T12:00:00.000Z',
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
    }),
    resolveRuntimeBuildRequestIdentityImpl: async ({ selection }) => {
      assert.deepEqual(selection.components, { web: true, server: false, daemon: false });
      return {
        sourceMetadata: {
          repoDir: '/repo',
          sourceFingerprint: 'provenance-a',
          builtAt: '2026-08-16T12:00:00.000Z',
          serverComponent: 'happier-server-light',
          dbProvider: 'sqlite',
        },
        artifactFingerprints: { web: 'web-code-a' },
        supportArtifactFingerprints: {},
      };
    },
    buildSelectedStackArtifactsImpl: async ({ buildComponent }) => ({
      web: await buildComponent('web', async () => ({
        artifactDir: '/stacks/repository-producer/artifacts/web/web-code-a',
        manifest: { component: 'web', artifactFingerprint: 'web-code-a' },
      })),
    }),
  });

  assert.equal(workspacePreparationCalls, 0);
  assert.equal(result.artifacts.web.manifest.artifactFingerprint, 'web-code-a');
});

async function createOptionalPluginCompilerFixture(repoRoot) {
  const { ensureWorkspacePackagesBuiltByName } = await import('../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  // Match buildSharedDeps' canonical graph fixture: replace only the compiler
  // process; real package admission, failure isolation and output publication run.
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
  }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
  for (const app of ['ui', 'server']) {
    mkdirSync(join(repoRoot, 'apps', app), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  for (const name of ['healthy', 'broken']) {
    const packageDir = join(repoRoot, 'packages', 'plugins', name);
    const manifestPath = join(packageDir, 'package.json');
    writeFileSync(manifestPath, JSON.stringify({
      ...JSON.parse(readFileSync(manifestPath, 'utf8')),
      type: 'module', main: './dist/index.js', scripts: { build: 'fixture-compiler' },
    }));
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const source = true;\n');
  }
  return async (root, packageNames, options) => await ensureWorkspacePackagesBuiltByName(root, packageNames, {
    ...options,
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => ({ ...env }),
      runPackageBuild: async (packageDir, { env }) => {
        if (packageDir === join(repoRoot, 'packages', 'plugins', 'broken')) throw new Error('broken staged export');
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const healthy = true;\n');
      },
    },
  });
}

test('daemon component publication retains a healthy plugin when an optional sibling build fails', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runtime-daemon-plugin-isolation-'));
  try {
    const stackDir = join(repoRoot, 'apps', 'stack');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(join(repoRoot, 'apps', 'cli'), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: {
        '@happier-dev/plugins-healthy': '0.0.0',
        '@happier-dev/plugins-broken': '0.0.0',
      },
      bundledDependencies: ['@happier-dev/plugins-healthy', '@happier-dev/plugins-broken'],
    }));
    for (const name of ['healthy', 'broken']) {
      const packageDir = join(repoRoot, 'packages', 'plugins', name);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: `@happier-dev/plugins-${name}`,
      }));
      writeFileSync(join(packageDir, 'tsconfig.json'), '{}\n');
    }
    const compileWorkspaces = await createOptionalPluginCompilerFixture(repoRoot);
    const { buildBundledWorkspaceDependenciesForCli } = await import('../../../cli/scripts/buildSharedDeps.mjs');
    const published = [];
    let identityReads = 0;
    const sourceMetadata = { repoDir: repoRoot, sourceFingerprint: 'source-a' };
    const result = await buildModule.buildRuntimeArtifactComponents({
      rootDir: stackDir,
      stackBaseDir: join(repoRoot, 'producer'),
      selection: {
        components: { web: false, server: false, daemon: true },
        activateRuntime: true,
        forceRebuild: false,
      },
      env: {},
      assertSelectedBuildPrerequisitesImpl: () => {},
      prepareBundledPluginPublicationInputsImpl: async () => {
        assert.equal(identityReads, 1, 'preparation follows the admission probe, before final identity capture');
        await buildBundledWorkspaceDependenciesForCli({
          repoRoot,
          publicationMode: 'live',
          workspaceNames: ['plugins-healthy', 'plugins-broken'],
          ensureWorkspacePackagesBuiltByNameImpl: compileWorkspaces,
          publishBundledPluginArtifactsImpl: async ({ workspaceNames, pluginFailures }) => {
            published.push({ workspaceNames, pluginFailures });
            return true;
          },
        });
      },
      collectBuildSourceMetadataImpl: async () => sourceMetadata,
      resolveRuntimeBuildRequestIdentityImpl: async () => {
        identityReads++;
        return { sourceMetadata, artifactFingerprints: { daemon: 'daemon-a' }, supportArtifactFingerprints: {} };
      },
      readCliBinaryArtifactWorkspacePublicationImpl: async () => {
        return { workspaceRuntimeIdentity: 'a'.repeat(64), workspaceRuntimePackages: [] };
      },
      buildSelectedStackArtifactsImpl: async ({ buildComponent }) => ({
        daemon: await buildComponent('daemon', async () => ({
          artifactDir: join(repoRoot, 'producer', 'daemon-a'),
          manifest: { component: 'daemon', artifactFingerprint: 'daemon-a' },
        })),
      }),
    });
    assert.equal(result.artifacts.daemon.manifest.artifactFingerprint, 'daemon-a');
    // The publisher retains evaluated manifest scope; failures separately
    // exclude broken executable artifacts in the canonical generator.
    assert.deepEqual(published.map(({ workspaceNames }) => workspaceNames), [['plugins-healthy', 'plugins-broken']]);
    assert.deepEqual(published[0].pluginFailures.map(({ packageName }) => packageName), [
      '@happier-dev/plugins-broken',
    ]);
    assert.deepEqual(published[0].pluginFailures[0].diagnostic, {
      code: 'plugin_package_build_failed', message: 'broken staged export',
    });
    assert.equal(readFileSync(join(repoRoot, 'packages', 'plugins', 'healthy', 'dist', 'index.js'), 'utf8'),
      'export const healthy = true;\n');
    assert.equal(existsSync(join(repoRoot, 'packages', 'plugins', 'broken', 'dist', 'index.js')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});


test('web-only publication recaptures component identity after preparing a cache miss', async () => {
  const events = [];
  const target = { platform: 'linux', arch: 'arm64' };
  const sourceMetadata = { repoDir: '/repo', sourceFingerprint: 'source-a' };
  await buildModule.buildRuntimeArtifactComponents({
    rootDir: '/repo/apps/stack',
    stackBaseDir: '/stacks/repository-producer',
    target,
    selection: {
      components: { web: true, server: false, daemon: false },
      activateRuntime: false,
      forceRebuild: false,
    },
    env: {},
    assertSelectedBuildPrerequisitesImpl: () => {},
    prepareBundledPluginPublicationInputsImpl: async () => { events.push('plugin-inputs'); },
    collectBuildSourceMetadataImpl: async () => { events.push('source-metadata'); return sourceMetadata; },
    resolveRuntimeBuildRequestIdentityImpl: async (input) => {
      assert.deepEqual(input.target, target);
      events.push('identity');
      return { sourceMetadata, artifactFingerprints: { web: 'web-a' }, supportArtifactFingerprints: {} };
    },
    buildSelectedStackArtifactsImpl: async ({ buildComponent }) => ({
      web: await buildComponent('web', async (input) => {
        assert.deepEqual(input.target, target);
        events.push('web-build');
        return { artifactDir: '/artifact/web', manifest: { artifactFingerprint: 'web-a' } };
      }),
    }),
  });
  assert.deepEqual(events, ['source-metadata', 'identity', 'plugin-inputs', 'source-metadata', 'identity', 'web-build']);
});

test('plugin input preflight republishes a UI artifact failure before identity capture', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_ui_artifact_invalid', message: 'missing bundle' }),
  });
  const events = [];
  await buildModule.prepareBundledPluginPublicationInputs({
    rootDir: '/repo/apps/stack',
    env: {},
    runCanonicalBundledPluginArtifactPublisherImpl: async (options) => {
      events.push(['projection', options.pluginFailures ?? []]);
    },
    generateBundledPluginUiArtifactsImpl: async () => {
      events.push(['ui-artifacts']);
      return { pluginFailures: [failure] };
    },
  });
  assert.deepEqual(events, [
    ['projection', []],
    ['ui-artifacts'],
    ['projection', [failure]],
  ]);
});

test('daemon preflight settles installed plugin diagnostics before UI artifact publication', async () => {
  const events = [];
  await buildModule.prepareBundledPluginPublicationInputs({
    rootDir: '/repo/apps/stack',
    selection: { components: { daemon: true, web: true, server: false } },
    env: {},
    runCanonicalBundledPluginArtifactPublisherImpl: async () => { events.push('projection'); },
    syncDaemonRuntimeDependenciesImpl: async () => { events.push('installed-sync'); },
    generateBundledPluginUiArtifactsImpl: async () => { events.push('ui-artifacts'); return { pluginFailures: [] }; },
  });
  assert.deepEqual(events, ['installed-sync', 'ui-artifacts']);
});

test('plugin input preflight resolves the monorepo root from either the repo root or the stack app dir', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
  for (const rootDir of [repoRoot, join(repoRoot, 'apps', 'stack')]) {
    const seen = [];
    await buildModule.prepareBundledPluginPublicationInputs({
      rootDir,
      env: {},
      runCanonicalBundledPluginArtifactPublisherImpl: async (options) => { seen.push(options.repoRoot); },
      generateBundledPluginUiArtifactsImpl: async (options) => { seen.push(options.repoRoot); return { pluginFailures: [] }; },
    });
    assert.deepEqual(seen, [repoRoot, repoRoot], rootDir);
  }
});

test('repository publication holds the runtime lock only for producer snapshot commit and never selects a consumer', async () => {
  assert.equal(typeof buildModule.publishBuiltRepositoryRuntimeSnapshot, 'function');
  const events = [];
  let runtimeLockHeld = false;
  const authority = {
    consumerStackName: 'source-main',
    consumerStackBaseDir: '/stacks/source-main',
    producerStackName: 'repo-producer',
    producerStackBaseDir: '/stacks/repo-producer',
  };
  const artifacts = Object.fromEntries(['web', 'server', 'daemon'].map((component) => [component, {
    artifactDir: `/stacks/repo-producer/artifacts/${component}/${component}-new`,
    manifest: { artifactFingerprint: `${component}-new` },
  }]));

  const result = await buildModule.publishBuiltRepositoryRuntimeSnapshot({
    authority,
    selection: {
      components: { web: true, server: true, daemon: true },
      activateRuntime: true,
    },
    requestedComponents: ['web', 'server', 'daemon'],
    sourceMetadata: {
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
      sourceFingerprint: 'provenance-only',
      builtAt: '2026-08-16T12:00:00.000Z',
    },
    artifacts,
    env: {},
    retentionPolicy: { runtimeSnapshotKeepCount: 2, artifactKeepCount: 2 },
    withWorkspaceBundleLockImpl: async (fn, options) => {
      assert.equal(options.lockPath, join(authority.producerStackBaseDir, 'runtime', 'build.lock'));
      runtimeLockHeld = true;
      try {
        return await fn({ waited: false });
      } finally {
        runtimeLockHeld = false;
      }
    },
    inspectActiveRuntimeSnapshotImpl: async () => {
      assert.equal(runtimeLockHeld, true);
      events.push('validate-current');
      return { valid: false, manifest: null, snapshot: null };
    },
    publishRuntimeSnapshotImpl: async (input) => {
      assert.equal(runtimeLockHeld, true);
      assert.equal(input.pruneAfterPublish, false);
      events.push('publish-manifest');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        reused: false,
      };
    },
    selectRuntimeSnapshotImpl: async (input) => {
      assert.equal(runtimeLockHeld, true);
      assert.equal(input.consumerStackBaseDir, authority.producerStackBaseDir);
      events.push('select-producer');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        currentPath: '/stacks/repo-producer/runtime/current.json',
      };
    },
    pruneRuntimeSnapshotsImpl: async () => {
      assert.equal(runtimeLockHeld, false);
      events.push('retention');
    },
  });

  assert.deepEqual(events, ['validate-current', 'publish-manifest', 'select-producer', 'retention']);
  assert.equal(result.selected, false);
  assert.equal(result.components.join(','), 'web,server,daemon');
  assert.equal(result.snapshotId.length > 0, true);
});

test('background demand projection does no preparation even when the selected source tree is absent', async (t) => {
  const stackBaseDir = mkdtempSync(join(tmpdir(), 'runtime-publication-demand-'));
  t.after(() => rmSync(stackBaseDir, { recursive: true, force: true }));
  const result = await buildModule.resolveRepositoryRuntimePublicationComponents({
    rootDir: join(stackBaseDir, 'absent-source'),
    authority: { producerStackBaseDir: stackBaseDir },
    requestedComponents: ['daemon', 'server', 'outside-domain'],
    env: {},
  });
  assert.deepEqual(result, { components: ['server', 'daemon'], currentSnapshotId: null });
});
