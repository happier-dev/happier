import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildDaemonArtifact,
  linkDaemonSupportPayload,
} from './build_daemon_artifact.mjs';

async function writeDaemonSupportPayload({ payloadDir, fingerprint }) {
  await mkdir(join(payloadDir, 'node_modules'), { recursive: true });
  await mkdir(join(payloadDir, 'tools'), { recursive: true });
  await mkdir(join(payloadDir, 'scripts'), { recursive: true });
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

test('two concurrent code-only daemon publications reuse one immutable support payload without copying stable entries again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-reuse-'));
  const stackBaseDir = join(root, 'stack');
  const supportFingerprint = 'daemon-support-stable';
  const supportWorkspaceRuntimeIdentity = 'a'.repeat(64);
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
      sourceMetadata: sourceMetadata(root),
      resolveDaemonSupportArtifactFingerprintImpl: async () => supportFingerprint,
      buildDaemonSupportArtifactPayloadImpl: async (args) => {
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

test('daemon code preparation detects support drift before copying the stale support closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-daemon-support-drift-'));
  const stackBaseDir = join(root, 'stack');
  const events = [];
  try {
    await assert.rejects(
      buildDaemonArtifact({
        rootDir: root,
        stackBaseDir,
        artifactDir: join(stackBaseDir, 'artifacts', 'daemon', 'daemon-code'),
        artifactFingerprint: 'daemon-code',
        supportArtifactFingerprint: 'daemon-support-before-code-build',
        sourceMetadata: sourceMetadata(root),
        resolveDaemonSupportArtifactFingerprintImpl: async () => {
          events.push('support-identity-after-code');
          return 'daemon-support-after-code-build';
        },
        buildDaemonSupportArtifactPayloadImpl: async (args) => {
          events.push('support-copy');
          return await writeDaemonSupportPayload({
            payloadDir: args.payloadDir,
            fingerprint: 'daemon-support-before-code-build',
          });
        },
        buildCliBinaryArtifactPayloadImpl: async (args) => {
          events.push('code');
          return await writeDaemonCodePayload(args);
        },
        writeCliBinaryArtifactRuntimeAssetBuildManifestImpl: () => {},
      }),
      /daemon support publication changed before staging/i,
    );

    assert.deepEqual(events, ['code', 'support-identity-after-code']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
