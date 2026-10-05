import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildDaemonArtifact,
  linkDaemonSupportPayload,
  readDaemonWorkspaceSourceFingerprint,
} from './build_daemon_artifact.mjs';
import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

test('daemon workspace support identity observes source changes before a dist is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-source-identity-'));
  const pluginDir = join(root, 'packages', 'plugins', 'fixture');
  const sourcePath = join(pluginDir, 'src', 'index.ts');
  const generatorPath = join(root, 'apps', 'cli', 'scripts', 'build-owned', 'generateBundledPluginEntries.ts');
  const rendererPath = join(root, 'apps', 'cli', 'scripts', 'build-owned', 'bundledPlugins', 'registry.ts');
  const authorPath = join(root, 'apps', 'cli', 'src', 'plugins', 'authoring', 'sourceModule.ts');
  const dependencyPath = join(authorPath, '..', 'dependency.ts');
  try {
    await mkdir(join(pluginDir, 'src'), { recursive: true });
    await mkdir(join(generatorPath, '..'), { recursive: true });
    await mkdir(join(rendererPath, '..'), { recursive: true });
    await writeFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/plugins-fixture'],
      dependencies: { '@happier-dev/plugins-fixture': '0.0.0' },
    }));
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-fixture',
      files: ['dist', 'resources', 'assets', '.happier-plugin', 'package.json'],
      scripts: { build: 'fixture-build' },
    }));
    await writeFile(sourcePath, 'export const value = 1;\n');
    await writeFile(generatorPath, 'export const generator = 1;\n');
    await writeFile(rendererPath, 'export const renderRegistry = () => "one";\n');
    await mkdir(join(authorPath, '..'), { recursive: true });
    await writeFile(authorPath, "import './dependency.ts';\nexport const author = 1;\n");
    await writeFile(dependencyPath, 'export const value = 1;\n');
    const promptPath = join(pluginDir, 'resources', 'review-prompt.md');
    const assetPath = join(pluginDir, 'assets', 'icon.svg');
    const serializedManifestPath = join(pluginDir, '.happier-plugin', 'plugin.json');
    await mkdir(join(promptPath, '..'), { recursive: true });
    await mkdir(join(assetPath, '..'), { recursive: true });
    await mkdir(join(serializedManifestPath, '..'), { recursive: true });
    await writeFile(promptPath, 'prompt one\n');
    await writeFile(assetPath, '<svg>one</svg>\n');
    await writeFile(serializedManifestPath, '{"id":"old"}\n');

    const initial = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    await writeFile(serializedManifestPath, '{"id":"generated"}\n');
    assert.equal(readDaemonWorkspaceSourceFingerprint({ repoDir: root }), initial,
      'generator output must not change the pre-preparation identity');
    await writeFile(promptPath, 'prompt two\n');
    const changedPrompt = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    await writeFile(assetPath, '<svg>two</svg>\n');
    const changedAsset = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    assert.notEqual(changedPrompt, initial);
    assert.notEqual(changedAsset, changedPrompt);
    await writeFile(sourcePath, 'export const value = 2;\n');
    const changedSource = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    await writeFile(generatorPath, 'export const generator = 2;\n');
    const changedGenerator = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    assert.notEqual(changedSource, initial);
    assert.notEqual(changedGenerator, changedSource);
    await writeFile(rendererPath, 'export const renderRegistry = () => "two";\n');
    const changedRenderer = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    assert.notEqual(changedRenderer, changedGenerator,
      'a renderer-only source change must invalidate the same daemon support identity');
    await writeFile(join(rendererPath, '..', 'registry.test.ts'), 'test fixture changed\n');
    assert.equal(readDaemonWorkspaceSourceFingerprint({ repoDir: root }), changedRenderer,
      'test-only changes must retain the same daemon support identity');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'unrelated.md'), 'unrelated docs');
    await writeFile(join(root, 'apps', 'cli', 'src', 'daemon.ts'), 'unrelated daemon source');
    assert.equal(readDaemonWorkspaceSourceFingerprint({ repoDir: root }), changedRenderer,
      'unrelated docs and daemon-only edits must retain warm generator support reuse');
    await writeFile(dependencyPath, 'export const value = 2;\n');
    const changedDependency = readDaemonWorkspaceSourceFingerprint({ repoDir: root });
    assert.notEqual(changedDependency, changedRenderer, 'transitive authoring inputs invalidate support');
    await rm(authorPath);
    assert.notEqual(readDaemonWorkspaceSourceFingerprint({ repoDir: root }), changedDependency,
      'deleted authoring entries invalidate support');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeDaemonSupportPayload({ payloadDir, fingerprint }) {
  await mkdir(join(payloadDir, 'node_modules'), { recursive: true });
  await mkdir(join(payloadDir, 'tools'), { recursive: true });
  await mkdir(join(payloadDir, 'scripts'), { recursive: true });
  await mkdir(join(payloadDir, '.project'), { recursive: true });
  await writeFile(join(payloadDir, 'node_modules', 'runtime.txt'), `runtime:${fingerprint}`, 'utf8');
  await writeFile(join(payloadDir, 'tools', 'tool.txt'), `tool:${fingerprint}`, 'utf8');
  await writeFile(join(payloadDir, 'scripts', 'sidecar.cjs'), `sidecar:${fingerprint}`, 'utf8');
  const entrypoint = '.happier-daemon-support.json';
  await writeFile(join(payloadDir, entrypoint), JSON.stringify({ fingerprint }), 'utf8');
  return { entrypoint, workspaceRuntimeIdentity: 'a'.repeat(64) };
}

async function writeDaemonCodePayload({ payloadDir }) {
  await mkdir(join(payloadDir, 'package-dist'), { recursive: true });
  await writeFile(join(payloadDir, 'happier'), 'daemon binary', 'utf8');
  await writeFile(join(payloadDir, 'package-dist', 'index.mjs'), 'export {};', 'utf8');
  return { entrypoint: 'happier', workspaceRuntimeIdentity: 'a'.repeat(64) };
}

function sourceMetadata(root) {
  return {
    repoDir: root,
    sourceFingerprint: 'daemon-source',
    builtAt: '2026-08-16T10:00:00.000Z',
  };
}

async function readFixtureGoVersion(command, args) {
  assert.equal(command, 'go');
  assert.deepEqual(args, ['version']);
  return 'go version go1.fixture linux/arm64';
}

test('two concurrent code-only daemon publications reuse one immutable support payload without copying stable entries again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-reuse-'));
  const stackBaseDir = join(root, 'stack');
  const supportFingerprint = 'daemon-support-stable';
  const supportWorkspaceRuntimeIdentity = 'a'.repeat(64);
  const preparedWorkspacePublication = {
    workspaceRuntimeIdentity: supportWorkspaceRuntimeIdentity,
    workspaceRuntimePackages: ['@happier-dev/cli-common'],
  };
  let supportBuilds = 0;
  let codeBuilds = 0;
  const runtimeManifestInputs = [];
  let releaseFirstSupportBuild;
  const firstSupportBuildStarted = new Promise((resolve) => {
    // The support builder resolves this only once it has crossed the
    // immutable-artifact existence check, making a second publication race
    // deterministic without mocking the production lock.
    releaseFirstSupportBuild = resolve;
  });
  let continueFirstSupportBuild;
  const allowFirstSupportBuildToFinish = new Promise((resolve) => {
    continueFirstSupportBuild = resolve;
  });
  try {
    const build = async (artifactFingerprint) => await buildDaemonArtifact({
      rootDir: root,
      stackBaseDir,
      artifactDir: join(stackBaseDir, 'artifacts', 'daemon', artifactFingerprint),
      artifactFingerprint,
      supportArtifactFingerprint: supportFingerprint,
      preparedWorkspacePublication,
      requiredCliDistInputFingerprint: 'c'.repeat(64),
      workspaceSourceFingerprint: 'd'.repeat(64),
      sourceMetadata: sourceMetadata(root),
      runCaptureImpl: readFixtureGoVersion,
      resolveDaemonSupportArtifactFingerprintImpl: async () => supportFingerprint,
      buildDaemonSupportArtifactPayloadImpl: async (args) => {
        assert.equal(args.workspaceSourceFingerprint, 'd'.repeat(64));
        supportBuilds += 1;
        if (supportBuilds === 1) {
          releaseFirstSupportBuild();
          await allowFirstSupportBuildToFinish;
        }
        return await writeDaemonSupportPayload({
          payloadDir: args.payloadDir,
          fingerprint: supportFingerprint,
        });
      },
      buildCliBinaryArtifactPayloadImpl: async (args) => {
        codeBuilds += 1;
        assert.equal(args.preparedWorkspacePublication, preparedWorkspacePublication);
        assert.equal(args.requiredCliDistInputFingerprint, 'c'.repeat(64));
        return await writeDaemonCodePayload(args);
      },
      writeCliBinaryArtifactRuntimeAssetBuildManifestImpl: (params) => {
        runtimeManifestInputs.push(params);
      },
    });

    const firstBuild = build('daemon-code-one');
    await firstSupportBuildStarted;
    const secondBuild = build('daemon-code-two');
    continueFirstSupportBuild();
    const [first, second] = await Promise.all([firstBuild, secondBuild]);

    assert.equal(supportBuilds, 1);
    assert.equal(codeBuilds, 2);
    assert.deepEqual(
      runtimeManifestInputs.map((params) => params.workspaceRuntimeIdentity),
      [supportWorkspaceRuntimeIdentity, supportWorkspaceRuntimeIdentity],
    );
    assert.equal(first.manifest.daemonSupportArtifactFingerprint, supportFingerprint);
    assert.equal(second.manifest.daemonSupportArtifactFingerprint, supportFingerprint);
    const supportPayloadDir = join(stackBaseDir, 'artifacts', 'daemon-support', supportFingerprint, 'payload');
    assert.equal(
      await readFile(join(second.artifactDir, 'payload', 'node_modules', 'runtime.txt'), 'utf8'),
      `runtime:${supportFingerprint}`,
    );
    assert.equal((await lstat(join(second.artifactDir, 'payload', 'node_modules'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(supportPayloadDir, 'node_modules'))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a changed daemon support identity publishes only a new daemon support artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-change-'));
  const stackBaseDir = join(root, 'stack');
  const supportBuilds = [];
  try {
    const build = async ({ artifactFingerprint, supportArtifactFingerprint }) => await buildDaemonArtifact({
      rootDir: root,
      stackBaseDir,
      artifactDir: join(stackBaseDir, 'artifacts', 'daemon', artifactFingerprint),
      artifactFingerprint,
      supportArtifactFingerprint,
      sourceMetadata: sourceMetadata(root),
      runCaptureImpl: readFixtureGoVersion,
      resolveDaemonSupportArtifactFingerprintImpl: async () => supportArtifactFingerprint,
      buildDaemonSupportArtifactPayloadImpl: async (args) => {
        supportBuilds.push(supportArtifactFingerprint);
        return await writeDaemonSupportPayload({
          payloadDir: args.payloadDir,
          fingerprint: supportArtifactFingerprint,
        });
      },
      buildCliBinaryArtifactPayloadImpl: writeDaemonCodePayload,
      writeCliBinaryArtifactRuntimeAssetBuildManifestImpl: () => {},
    });

    const first = await build({
      artifactFingerprint: 'daemon-code-old-support',
      supportArtifactFingerprint: 'daemon-support-old',
    });
    const second = await build({
      artifactFingerprint: 'daemon-code-new-support',
      supportArtifactFingerprint: 'daemon-support-new',
    });

    assert.deepEqual(supportBuilds, ['daemon-support-old', 'daemon-support-new']);
    assert.equal(first.manifest.daemonSupportArtifactFingerprint, 'daemon-support-old');
    assert.equal(second.manifest.daemonSupportArtifactFingerprint, 'daemon-support-new');
    assert.equal(
      await readFile(join(first.artifactDir, 'payload', 'tools', 'tool.txt'), 'utf8'),
      'tool:daemon-support-old',
    );
    assert.equal(
      await readFile(join(second.artifactDir, 'payload', 'tools', 'tool.txt'), 'utf8'),
      'tool:daemon-support-new',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon reuse rejects missing support and repairs it through the support builder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackBaseDir = join(root, 'stack');
  const artifactDir = join(stackBaseDir, 'artifacts', 'daemon', 'code');
  let supportBuilds = 0;
  const options = {
    rootDir: root, stackBaseDir, artifactDir, artifactFingerprint: 'code',
    supportArtifactFingerprint: 'support', sourceMetadata: sourceMetadata(root),
    runCaptureImpl: readFixtureGoVersion,
    buildDaemonSupportArtifactPayloadImpl: async (args) => {
      supportBuilds += 1;
      return writeDaemonSupportPayload({ ...args, fingerprint: 'support' });
    },
    buildCliBinaryArtifactPayloadImpl: writeDaemonCodePayload,
    writeCliBinaryArtifactRuntimeAssetBuildManifestImpl: () => {},
  };
  await buildDaemonArtifact(options);
  assert.ok(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'code' }));
  await buildDaemonArtifact(options);
  assert.equal(supportBuilds, 1, 'healthy payloads reuse');
  await rm(join(stackBaseDir, 'artifacts', 'daemon-support', 'support'), { recursive: true });
  assert.equal(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'code' }), null);
  await buildDaemonArtifact(options);
  assert.equal(supportBuilds, 2, 'missing support must be rebuilt');
  assert.ok(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'code' }));
  assert.equal(await readFile(join(artifactDir, 'payload', 'tools', 'tool.txt'), 'utf8'), 'tool:support');
  await rm(join(stackBaseDir, 'artifacts', 'daemon-support', 'support', 'payload', 'tools'), { recursive: true });
  assert.equal(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'code' }), null);
  await buildDaemonArtifact(options);
  assert.equal(supportBuilds, 3, 'incomplete support payloads repair too');
});

test('daemon support references request Windows junctions for directory payloads', async () => {
  const calls = [];
  await linkDaemonSupportPayload({
    codePayloadDir: '/artifact/daemon/payload',
    supportPayloadDir: '/artifact/daemon-support/payload',
    platform: 'win32',
    mkdirImpl: async () => {},
    rmImpl: async () => {},
    symlinkImpl: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [
    ['/artifact/daemon-support/payload/node_modules', '/artifact/daemon/payload/node_modules', 'junction'],
    ['/artifact/daemon-support/payload/tools', '/artifact/daemon/payload/tools', 'junction'],
    ['/artifact/daemon-support/payload/scripts', '/artifact/daemon/payload/scripts', 'junction'],
    ['/artifact/daemon-support/payload/.project', '/artifact/daemon/payload/.project', 'junction'],
  ]);
});

test('legacy self-contained daemon artifacts remain reusable without a daemon support reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-legacy-reuse-'));
  const artifactDir = join(root, 'artifacts', 'daemon', 'legacy-daemon');
  let resolverCalls = 0;
  try {
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', 'happier'), 'legacy daemon binary', 'utf8');
    await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify({
      version: 1,
      component: 'daemon',
      artifactFingerprint: 'legacy-daemon',
      sourceFingerprint: 'legacy-source',
      createdAt: '2026-08-16T10:00:00.000Z',
      source: sourceMetadata(root),
      payloadDir: 'payload',
      entrypoint: 'happier',
    }), 'utf8');

    const reused = await buildDaemonArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'legacy-daemon',
      sourceMetadata: sourceMetadata(root),
      resolveDaemonSupportArtifactFingerprintImpl: async () => {
        resolverCalls += 1;
        return 'must-not-be-resolved';
      },
    });

    assert.equal(reused.manifest.daemonSupportArtifactFingerprint, undefined);
    assert.equal(resolverCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
