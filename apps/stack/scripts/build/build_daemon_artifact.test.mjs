import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildDaemonArtifact,
  linkDaemonSupportPayload,
} from './build_daemon_artifact.mjs';
import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

test('daemon support links native dependencies while preserving the code-owned plugin graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-source-support-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, 'code');
  const support = join(root, 'support');
  const plugin = join(code, 'node_modules', '@happier-dev', 'plugins-fixture', 'index.js');
  const native = join(support, 'node_modules', '@img', 'sharp-linux-x64', 'binding.node');
  await mkdir(join(plugin, '..'), { recursive: true });
  await mkdir(join(native, '..'), { recursive: true });
  await writeFile(plugin, 'export const sharedGraph = true;');
  await writeFile(native, 'native fixture');
  const sidecar = join(code, 'scripts', 'process_tree.cjs');
  await mkdir(join(sidecar, '..'), { recursive: true });
  await writeFile(sidecar, 'module.exports = "source-owned sidecar";');
  const nestedNative = join(support, 'node_modules', '@happier-dev', 'plugins-fixture', 'node_modules', 'native-fixture', 'binding.node');
  await mkdir(join(nestedNative, '..'), { recursive: true });
  await writeFile(nestedNative, 'nested native fixture');
  await linkDaemonSupportPayload({ codePayloadDir: code, supportPayloadDir: support });
  assert.equal(await readFile(plugin, 'utf8'), 'export const sharedGraph = true;');
  assert.equal(await readFile(sidecar, 'utf8'), 'module.exports = "source-owned sidecar";');
  assert.equal(await readFile(join(code, 'node_modules', '@img', 'sharp-linux-x64', 'binding.node'), 'utf8'), 'native fixture');
  assert.equal(await readFile(join(plugin, '..', 'node_modules', 'native-fixture', 'binding.node'), 'utf8'), 'nested native fixture');
});

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

async function writeDaemonSupportPayload({ payloadDir, fingerprint }) {
  await mkdir(join(payloadDir, 'node_modules', 'native-fixture'), { recursive: true });
  await mkdir(join(payloadDir, 'tools'), { recursive: true });
  await mkdir(join(payloadDir, '.project'), { recursive: true });
  await writeFile(join(payloadDir, 'node_modules', 'native-fixture', 'index.js'), `runtime:${fingerprint}`, 'utf8');
  await writeFile(join(payloadDir, 'tools', 'tool.txt'), `tool:${fingerprint}`, 'utf8');
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

test('two concurrent code-only daemon publications reuse one immutable support payload without copying stable entries again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-reuse-'));
  const stackBaseDir = join(root, 'stack');
  const supportFingerprint = 'daemon-support-stable';
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
      target: { platform: 'linux', arch: 'arm64' },
      sourceMetadata: sourceMetadata(root),
      runCaptureImpl: readFixtureGoVersion,
      resolveDaemonSupportArtifactFingerprintImpl: async () => supportFingerprint,
      buildDaemonSupportArtifactPayloadImpl: async (args) => {
        assert.equal(args.target.os, 'linux');
        assert.equal(args.target.arch, 'arm64');
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
        assert.equal(args.target.arch, 'arm64');
        assert.equal(args.target.bunTarget, 'bun-linux-arm64');
        codeBuilds += 1;
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
      [undefined, undefined],
    );
    assert.equal(first.manifest.daemonSupportArtifactFingerprint, supportFingerprint);
    assert.equal(second.manifest.daemonSupportArtifactFingerprint, supportFingerprint);
    assert.deepEqual(second.manifest.target, { platform: 'linux', arch: 'arm64' });
    assert.deepEqual(JSON.parse(await readFile(join(stackBaseDir, 'artifacts', 'daemon-support', supportFingerprint, 'manifest.json'), 'utf8')).target,
      { platform: 'linux', arch: 'arm64' });
    const supportPayloadDir = join(stackBaseDir, 'artifacts', 'daemon-support', supportFingerprint, 'payload');
    assert.equal(
      await readFile(join(second.artifactDir, 'payload', 'node_modules', 'native-fixture', 'index.js'), 'utf8'),
      `runtime:${supportFingerprint}`,
    );
    assert.equal((await lstat(join(second.artifactDir, 'payload', 'node_modules', 'native-fixture'))).isSymbolicLink(), true);
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
    ['/artifact/daemon-support/payload/tools', '/artifact/daemon/payload/tools', 'junction'],
    ['/artifact/daemon-support/payload/.project', '/artifact/daemon/payload/.project', 'junction'],
  ]);
});

test('daemon publication requires its producer store even when an undeployed predecessor artifact exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-legacy-reuse-'));
  const artifactDir = join(root, 'artifacts', 'daemon', 'legacy-daemon');
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

    await assert.rejects(buildDaemonArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'legacy-daemon',
      sourceMetadata: sourceMetadata(root),
    }), /requires its producer artifact store path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
