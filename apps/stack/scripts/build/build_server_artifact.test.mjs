import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServerArtifact, resolveRuntimeServerUiWebDistPath } from './build_server_artifact.mjs';
import { writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

test('runtime server artifacts require and reuse the canonical web artifact payload', async () => {
  const observed = [];
  const resolved = await resolveRuntimeServerUiWebDistPath({
    uiWebDistPath: '/runtime/artifacts/web/fingerprint/payload',
    pathExistsImpl: async (path) => {
      observed.push(path);
      return path.endsWith('/index.html');
    },
  });

  assert.equal(resolved, '/runtime/artifacts/web/fingerprint/payload');
  assert.deepEqual(observed, ['/runtime/artifacts/web/fingerprint/payload/index.html']);
});

test('runtime server artifacts fail before packaging when no canonical web artifact exists', async () => {
  await assert.rejects(
    resolveRuntimeServerUiWebDistPath({ uiWebDistPath: '', pathExistsImpl: async () => false }),
    /web artifact/i,
  );
});

test('server artifact manifests retain the exact canonical web artifact fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-provenance-'));
  const artifactDir = join(root, 'artifact');
  const uiWebDistPath = join(root, 'web', 'payload');
  try {
    await mkdir(uiWebDistPath, { recursive: true });
    await writeFile(join(uiWebDistPath, 'index.html'), '<!doctype html>', 'utf8');

    const result = await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-12T10:00:00.000Z',
      },
      uiWebDistPath,
      webArtifactFingerprint: 'published-web-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        const entrypoint = 'happier-server-light';
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'server bytes', 'utf8');
        return { entrypoint };
      },
    });

    assert.equal(result.manifest.webArtifactFingerprint, 'published-web-fingerprint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server artifact packaging consumes the same explicit environment used by its build owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-env-'));
  const artifactDir = join(root, 'artifact');
  const uiWebDistPath = join(root, 'web', 'payload');
  const buildEnv = {
    HAPPIER_SERVER_BUN_EXTERNALS: 'redis,custom-runtime',
    HAPPIER_BUILD_DB_PROVIDERS: 'sqlite',
  };
  let observed = null;
  try {
    await mkdir(uiWebDistPath, { recursive: true });
    await writeFile(join(uiWebDistPath, 'index.html'), '<!doctype html>', 'utf8');

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
      uiWebDistPath,
      webArtifactFingerprint: 'published-web-fingerprint',
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

test('server artifacts do not reuse bytes built from a different canonical web artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-web-identity-'));
  const artifactDir = join(root, 'artifact');
  const uiWebDistPath = join(root, 'web', 'payload');
  const entrypoint = 'happier-server-light';
  try {
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', entrypoint), 'old server bytes', 'utf8');
    await writeArtifactManifest({
      artifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint: 'server-fingerprint',
        webArtifactFingerprint: 'old-web-fingerprint',
        sourceFingerprint: 'source-fingerprint',
        payloadDir: 'payload',
        entrypoint,
      },
    });
    await mkdir(uiWebDistPath, { recursive: true });
    await writeFile(join(uiWebDistPath, 'index.html'), '<!doctype html>', 'utf8');

    let buildCount = 0;
    const result = await buildServerArtifact({
      rootDir: root,
      artifactDir,
      artifactFingerprint: 'server-fingerprint',
      sourceMetadata: {
        repoDir: root,
        serverComponent: 'happier-server-light',
        sourceFingerprint: 'source-fingerprint',
        builtAt: '2026-08-12T10:00:00.000Z',
      },
      uiWebDistPath,
      webArtifactFingerprint: 'new-web-fingerprint',
      buildServerBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        buildCount += 1;
        await mkdir(payloadDir, { recursive: true });
        await writeFile(join(payloadDir, entrypoint), 'new server bytes', 'utf8');
        return { entrypoint };
      },
    });

    assert.equal(buildCount, 1);
    assert.equal(result.manifest.webArtifactFingerprint, 'new-web-fingerprint');
    assert.equal(await readFile(join(artifactDir, 'payload', entrypoint), 'utf8'), 'new server bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('force rebuild cannot overwrite a valid immutable server artifact fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-server-artifact-immutable-'));
  const artifactDir = join(root, 'artifact');
  const entrypoint = 'happier-server';
  try {
    await mkdir(join(artifactDir, 'payload'), { recursive: true });
    await writeFile(join(artifactDir, 'payload', entrypoint), 'published bytes', 'utf8');
    await writeArtifactManifest({
      artifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint: 'immutable-fingerprint',
        webArtifactFingerprint: 'published-web-fingerprint',
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
      uiWebDistPath: join(root, 'unused-web'),
      webArtifactFingerprint: 'published-web-fingerprint',
    });

    assert.equal(result.manifest.artifactFingerprint, 'immutable-fingerprint');
    assert.equal(result.manifest.webArtifactFingerprint, 'published-web-fingerprint');
    assert.equal(await readFile(join(artifactDir, 'payload', entrypoint), 'utf8'), 'published bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
