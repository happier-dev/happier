import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerArtifact, linkServerRuntimeSupportPayload } from './build_server_artifact.mjs';
import { writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

async function writeServerSupportArtifact({
  artifactDir,
  artifactFingerprint,
  serverComponent = 'happier-server-light',
}) {
  const payloadDir = join(artifactDir, 'payload');
  const entrypoint = '.happier-server-support.json';
  for (const name of ['generated', 'prisma', 'node_modules']) {
    await mkdir(join(payloadDir, name), { recursive: true });
    await writeFile(join(payloadDir, name, 'support.txt'), `${name}:${artifactFingerprint}`, 'utf8');
  }
  if (serverComponent === 'happier-server') {
    await mkdir(join(payloadDir, 'runtime'), { recursive: true });
    await writeFile(join(payloadDir, 'runtime', 'schema-engine'), 'schema engine', 'utf8');
    await writeFile(join(payloadDir, 'runtime', 'prisma_schema_build_bg.wasm'), 'schema wasm', 'utf8');
    await writeFile(join(payloadDir, 'runtime', 'prisma-migrate'), 'prisma migrate', 'utf8');
  }
  await writeFile(join(payloadDir, entrypoint), JSON.stringify({ version: 1, artifactFingerprint }), 'utf8');
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component: 'server-support',
      artifactFingerprint,
      sourceFingerprint: `source-${artifactFingerprint}`,
      payloadDir: 'payload',
      entrypoint,
    },
  });
}

test('managed server artifacts publish code without a web artifact and bind the exact server support artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-provenance-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-code-fingerprint');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'server-support-fingerprint');
  let observedPayloadArgs = null;
  try {
    await writeServerSupportArtifact({
      artifactDir: supportArtifactDir,
      artifactFingerprint: 'server-support-fingerprint',
    });

    const result = await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-code-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-12T10:00:00.000Z',
      },
      supportArtifactFingerprint: 'server-support-fingerprint',
      resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async (args) => {
        observedPayloadArgs = args;
        const { payloadDir } = args;
        const entrypoint = 'happier-server-light';
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'server bytes', 'utf8');
        return { entrypoint };
      },
    });

    assert.equal(result.manifest.serverSupportArtifactFingerprint, 'server-support-fingerprint');
    assert.equal(observedPayloadArgs?.includeRuntimeSupport, false);
    assert.equal(observedPayloadArgs?.uiWebDistPath, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed server code payload links the published server support directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-links-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-code-fingerprint');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'server-support-fingerprint');
  try {
    await writeServerSupportArtifact({
      artifactDir: supportArtifactDir,
      artifactFingerprint: 'server-support-fingerprint',
    });
    await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-code-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-16T10:00:00.000Z',
      },
      supportArtifactFingerprint: 'server-support-fingerprint',
      resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        const entrypoint = 'happier-server-light';
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'server bytes', 'utf8');
        return { entrypoint };
      },
    });

    for (const name of ['generated', 'prisma', 'node_modules']) {
      assert.equal((await lstat(join(artifactDir, 'payload', name))).isSymbolicLink(), true);
      assert.equal(
        await readFile(join(artifactDir, 'payload', name, 'support.txt'), 'utf8'),
        `${name}:server-support-fingerprint`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full managed server code receives Prisma migration runtime from server support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-full-links-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-code-fingerprint');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'server-support-fingerprint');
  try {
    await writeServerSupportArtifact({
      artifactDir: supportArtifactDir,
      artifactFingerprint: 'server-support-fingerprint',
      serverComponent: 'happier-server',
    });
    await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-code-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-16T10:00:00.000Z',
      },
      supportArtifactFingerprint: 'server-support-fingerprint',
      resolveServerSupportArtifactFingerprintImpl: async () => 'server-support-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, 'happier-server'), 'server bytes', 'utf8');
        await writeFile(join(payloadDir, 'happier-server-migrate'), 'server migrate bytes', 'utf8');
        return { entrypoint: 'happier-server', migrationEntrypoint: 'happier-server-migrate' };
      },
    });

    assert.equal((await lstat(join(artifactDir, 'payload', 'runtime'))).isSymbolicLink(), true);
    assert.equal(
      await readFile(join(artifactDir, 'payload', 'runtime', 'prisma-migrate'), 'utf8'),
      'prisma migrate',
    );
    assert.equal(
      await readFile(join(artifactDir, 'payload', 'happier-server-migrate'), 'utf8'),
      'server migrate bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server support references request Windows junctions for runtime directories', async () => {
  const calls = [];
  await linkServerRuntimeSupportPayload({
    codePayloadDir: 'C:\\artifact\\server\\payload',
    supportPayloadDir: 'C:\\artifact\\server-support\\payload',
    serverComponent: 'happier-server',
    platform: 'win32',
    mkdirImpl: async () => {},
    rmImpl: async () => {},
    symlinkImpl: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls.map(([target, link, type]) => [
    target.replaceAll('\\', '/'),
    link.replaceAll('\\', '/'),
    type,
  ]), [
    ['C:/artifact/server-support/payload/generated', 'C:/artifact/server/payload/generated', 'junction'],
    ['C:/artifact/server-support/payload/prisma', 'C:/artifact/server/payload/prisma', 'junction'],
    ['C:/artifact/server-support/payload/node_modules', 'C:/artifact/server/payload/node_modules', 'junction'],
    ['C:/artifact/server-support/payload/runtime', 'C:/artifact/server/payload/runtime', 'junction'],
  ]);
});

test('a second code-only server publication reuses support and copies neither support nor static web', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-code-only-'));
  const firstArtifactDir = join(root, 'artifacts', 'server', 'server-code-first');
  const secondArtifactDir = join(root, 'artifacts', 'server', 'server-code-second');
  const sourceMetadata = {
    repoDir: root,
    serverComponent: 'happier-server-light',
    sourceFingerprint: 'source-fingerprint',
    builtAt: '2026-08-16T10:00:00.000Z',
  };
  const supportInputs = {
    fingerprint: 'stable-server-support',
    entryCount: 1,
    entries: [],
    target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
    serverComponent: 'happier-server-light',
    buildDbProviders: 'sqlite',
  };
  let supportPayloadBuilds = 0;
  const codePayloadArgs = [];
  try {
    const buildServerBinaryArtifactPayloadImpl = async (args) => {
      codePayloadArgs.push(args);
      const entrypoint = 'happier-server-light';
      await mkdir(args.payloadDir, { recursive: true });
      await writeFile(join(args.payloadDir, entrypoint), 'server bytes', 'utf8');
      return { entrypoint };
    };
    const common = {
      rootDir: root,
      sourceMetadata,
      supportArtifactFingerprint: supportInputs.fingerprint,
      resolveServerSupportArtifactFingerprintImpl: async () => supportInputs.fingerprint,
      resolveServerRuntimeSupportInputsImpl: async () => supportInputs,
      buildServerRuntimeSupportPayloadImpl: async ({ payloadDir }) => {
        supportPayloadBuilds += 1;
        for (const name of ['generated', 'prisma', 'node_modules']) {
          await mkdir(join(payloadDir, name), { recursive: true });
          await writeFile(join(payloadDir, name, 'stable-native-support'), 'support bytes', 'utf8');
        }
      },
      buildServerBinaryArtifactPayloadImpl,
    };

    await buildServerArtifact({
      ...common,
      artifactDir: firstArtifactDir,
      artifactFingerprint: 'server-code-first',
    });
    await buildServerArtifact({
      ...common,
      artifactDir: secondArtifactDir,
      artifactFingerprint: 'server-code-second',
    });

    assert.equal(supportPayloadBuilds, 1);
    assert.equal(codePayloadArgs.length, 2);
    for (const args of codePayloadArgs) {
      assert.equal(args.includeRuntimeSupport, false);
      assert.equal('uiWebDistPath' in args, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server support publication serializes a shared support identity through its owner-local lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-support-lock-'));
  const firstArtifactDir = join(root, 'artifacts', 'server', 'server-code-first');
  const secondArtifactDir = join(root, 'artifacts', 'server', 'server-code-second');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'shared-server-support');
  const sourceMetadata = {
    repoDir: root,
    serverComponent: 'happier-server-light',
    sourceFingerprint: 'source-fingerprint',
    builtAt: '2026-08-16T10:00:00.000Z',
  };
  const supportInputs = {
    fingerprint: 'shared-server-support',
    entryCount: 1,
    entries: [],
    target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
    serverComponent: 'happier-server-light',
    buildDbProviders: 'sqlite',
  };
  let releaseFirstSupportBuild = null;
  const firstSupportBuildStarted = new Promise((resolve) => {
    releaseFirstSupportBuild = () => resolve();
  });
  let signalFirstSupportBuildStarted;
  const firstSupportBuildEntered = new Promise((resolve) => {
    signalFirstSupportBuildStarted = resolve;
  });
  let lockTail = Promise.resolve();
  const lockPaths = [];
  let supportPayloadBuilds = 0;
  let first = null;
  let second = null;
  try {
    const common = {
      rootDir: root,
      sourceMetadata,
      supportArtifactFingerprint: supportInputs.fingerprint,
      resolveServerSupportArtifactFingerprintImpl: async () => supportInputs.fingerprint,
      resolveServerRuntimeSupportInputsImpl: async () => supportInputs,
      withWorkspaceBundleLockImpl: async (fn, options) => {
        lockPaths.push(options.lockPath);
        const previous = lockTail;
        let release;
        lockTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await fn({ heldLockValue: 'test-server-support-lock' });
        } finally {
          release();
        }
      },
      buildServerRuntimeSupportPayloadImpl: async ({ payloadDir }) => {
        supportPayloadBuilds += 1;
        if (supportPayloadBuilds === 1) {
          signalFirstSupportBuildStarted();
          await firstSupportBuildStarted;
        }
        for (const name of ['generated', 'prisma', 'node_modules']) {
          await mkdir(join(payloadDir, name), { recursive: true });
          await writeFile(join(payloadDir, name, 'support.txt'), 'support bytes', 'utf8');
        }
      },
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        const entrypoint = 'happier-server-light';
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'server bytes', 'utf8');
        return { entrypoint };
      },
    };
    first = buildServerArtifact({
      ...common,
      artifactDir: firstArtifactDir,
      artifactFingerprint: 'server-code-first',
    });
    await firstSupportBuildEntered;
    second = buildServerArtifact({
      ...common,
      artifactDir: secondArtifactDir,
      artifactFingerprint: 'server-code-second',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(supportPayloadBuilds, 1);
    assert.deepEqual(lockPaths, [
      `${supportArtifactDir}.lock`,
      `${supportArtifactDir}.lock`,
    ]);
  } finally {
    releaseFirstSupportBuild?.();
    await Promise.allSettled([first, second].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});

test('server support publication rejects inputs that change while staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-support-currentness-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-code-currentness');
  const sourceMetadata = {
    repoDir: root,
    serverComponent: 'happier-server-light',
    sourceFingerprint: 'source-fingerprint',
    builtAt: '2026-08-16T10:00:00.000Z',
  };
  const supportInputs = {
    entryCount: 1,
    entries: [],
    target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
    serverComponent: 'happier-server-light',
    buildDbProviders: 'sqlite',
  };
  let supportInputReads = 0;
  let codePayloadBuilds = 0;
  try {
    await assert.rejects(
      buildServerArtifact({
        rootDir: root,
        artifactDir,
        artifactFingerprint: 'server-code-currentness',
        sourceMetadata,
        supportArtifactFingerprint: 'support-before-stage',
        resolveServerSupportArtifactFingerprintImpl: async () => 'support-before-stage',
        resolveServerRuntimeSupportInputsImpl: async () => ({
          ...supportInputs,
          fingerprint: supportInputReads++ === 0 ? 'support-before-stage' : 'support-after-stage',
        }),
        buildServerRuntimeSupportPayloadImpl: async ({ payloadDir }) => {
          for (const name of ['generated', 'prisma', 'node_modules']) {
            await mkdir(join(payloadDir, name), { recursive: true });
            await writeFile(join(payloadDir, name, 'support.txt'), 'support bytes', 'utf8');
          }
        },
        buildServerBinaryArtifactPayloadImpl: async () => {
          codePayloadBuilds += 1;
          throw new Error('server code must not publish after support inputs change');
        },
      }),
      /server runtime support inputs changed while staging/i,
    );

    assert.equal(codePayloadBuilds, 0);
    await assert.rejects(readFile(join(artifactDir, 'manifest.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server artifact packaging consumes the same explicit environment used by its build owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-env-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-env-fingerprint');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'support-fingerprint');
  const buildEnv = {
    HAPPIER_SERVER_BUN_EXTERNALS: 'redis,custom-runtime',
    HAPPIER_BUILD_DB_PROVIDERS: 'sqlite',
  };
  let observed = null;
  try {
    await writeServerSupportArtifact({ artifactDir: supportArtifactDir, artifactFingerprint: 'support-fingerprint' });

    await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-env-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-13T10:00:00.000Z',
      },
      env: buildEnv,
      supportArtifactFingerprint: 'support-fingerprint',
      resolveServerSupportArtifactFingerprintImpl: async () => 'support-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir, env, externals }) => {
        observed = { env, externals };
        const entrypoint = 'happier-server-light';
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'server bytes', 'utf8');
        return { entrypoint };
      },
    });

    assert.equal(observed?.env, buildEnv);
    assert.deepEqual(observed?.externals, ['redis', 'custom-runtime']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('immutable server code artifacts reject a different server support identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-support-identity-'));
  const artifactDir = join(root, 'artifacts', 'server', 'server-fingerprint');
  const oldSupportArtifactDir = join(root, 'artifacts', 'server-support', 'old-support-fingerprint');
  const newSupportArtifactDir = join(root, 'artifacts', 'server-support', 'new-support-fingerprint');
  const entrypoint = 'happier-server-light';
  try {
    await writeServerSupportArtifact({ artifactDir: oldSupportArtifactDir, artifactFingerprint: 'old-support-fingerprint' });
    await writeServerSupportArtifact({ artifactDir: newSupportArtifactDir, artifactFingerprint: 'new-support-fingerprint' });
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', entrypoint), 'old server bytes', 'utf8');
    await writeArtifactManifest({
      artifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint: 'server-fingerprint',
        serverSupportArtifactFingerprint: 'old-support-fingerprint',
        sourceFingerprint: 'source-fingerprint',
        payloadDir: 'payload',
        entrypoint,
      },
    });
    let buildCount = 0;
    await assert.rejects(
      buildServerArtifact({
        rootDir: root,
        artifactDir,
        artifactFingerprint: 'server-fingerprint',
        sourceMetadata: {
          repoDir: root,
          serverComponent: 'happier-server-light',
          sourceFingerprint: 'source-fingerprint',
          builtAt: '2026-08-12T10:00:00.000Z',
        },
        supportArtifactFingerprint: 'new-support-fingerprint',
        resolveServerSupportArtifactFingerprintImpl: async () => 'new-support-fingerprint',
        buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
          buildCount += 1;
          await mkdir(payloadDir, { recursive: true });
          await writeFile(join(payloadDir, entrypoint), 'new server bytes', 'utf8');
          return { entrypoint };
        },
      }),
      /immutable server artifact fingerprint is already bound to a different support artifact/i,
    );

    assert.equal(buildCount, 0);
    assert.equal(await readFile(join(artifactDir, 'payload', entrypoint), 'utf8'), 'old server bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy self-contained server artifacts remain reusable without a current support artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-legacy-'));
  const artifactDir = join(root, 'artifacts', 'server', 'legacy-fingerprint');
  const entrypoint = 'happier-server-light';
  try {
    await mkdir(join(artifactDir, 'payload', 'generated'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', entrypoint), 'legacy server bytes', 'utf8');
    await writeFile(join(artifactDir, 'payload', 'generated', 'client.js'), 'legacy generated client', 'utf8');
    await writeArtifactManifest({
      artifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint: 'legacy-fingerprint',
        sourceFingerprint: 'legacy-source-fingerprint',
        payloadDir: 'payload',
        entrypoint,
      },
    });

    const result = await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'legacy-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'new-source-fingerprint',
        builtAt: '2026-08-16T10:00:00.000Z',
      },
      resolveServerSupportArtifactFingerprintImpl: async () => {
        throw new Error('legacy reuse must not require current server support');
      },
      buildServerBinaryArtifactPayloadImpl: async () => {
        throw new Error('legacy reuse must not replace self-contained code');
      },
    });

    assert.equal(result.manifest.serverSupportArtifactFingerprint, undefined);
    assert.equal(await readFile(join(artifactDir, 'payload', entrypoint), 'utf8'), 'legacy server bytes');
    assert.equal(await readFile(join(artifactDir, 'payload', 'generated', 'client.js'), 'utf8'), 'legacy generated client');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('force rebuild cannot overwrite a valid immutable server artifact fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-immutable-'));
  const artifactDir = join(root, 'artifacts', 'server', 'immutable-fingerprint');
  const supportArtifactDir = join(root, 'artifacts', 'server-support', 'support-fingerprint');
  const entrypoint = 'happier-server';
  try {
    await writeServerSupportArtifact({ artifactDir: supportArtifactDir, artifactFingerprint: 'support-fingerprint' });
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', entrypoint), 'published bytes', 'utf8');
    await writeArtifactManifest({
      artifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint: 'immutable-fingerprint',
        serverSupportArtifactFingerprint: 'support-fingerprint',
        sourceFingerprint: 'source-fingerprint',
        payloadDir: 'payload',
        entrypoint,
      },
    });

    const result = await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'immutable-fingerprint',
      sourceMetadata: {},
      forceRebuild: true,
      supportArtifactFingerprint: 'support-fingerprint',
      resolveServerSupportArtifactFingerprintImpl: async () => 'support-fingerprint',
    });

    assert.equal(result.manifest.artifactFingerprint, 'immutable-fingerprint');
    assert.equal(result.manifest.serverSupportArtifactFingerprint, 'support-fingerprint');
    assert.equal(await readFile(join(artifactDir, 'payload', entrypoint), 'utf8'), 'published bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
