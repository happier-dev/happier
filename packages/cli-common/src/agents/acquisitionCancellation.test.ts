import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset';
import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset';
import { fetchNodeRuntimeReleaseAsset } from './nodeRelease';
import { createHash } from 'node:crypto';
import { installAgentCliForRuntime, resolvePlatformFromNodePlatform } from './install.js';
import type { AgentInstallProgressEvent } from './installProgress.js';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

test.each([
  { status: 200, badDigest: false, releaseFails: false },
  { status: 500, badDigest: false, releaseFails: false },
  { status: 200, badDigest: true, releaseFails: false },
  { status: 500, badDigest: false, releaseFails: true },
])('runtime installer preserves progress and typed download outcomes (HTTP $status, bad digest $badDigest, metadata $releaseFails)', async ({ status, badDigest, releaseFails }) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-progress-'));
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
  const events: AgentInstallProgressEvent[] = [];
  const platform = resolvePlatformFromNodePlatform(process.platform);
  if (!platform) throw new Error('Unsupported fixture platform');
  const assetName = process.platform === 'win32' ? 'fixture-windows-x64.exe' : `fixture-${process.platform}-${process.arch}`;
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const result = await installAgentCliForRuntime({
      runtimeSpec: {
        id: 'fixture', title: 'Fixture', binaryName: 'fixture', acceptsJavaScriptFileOverride: false,
        sourcePreferenceDefault: 'system-first',
        manualInstallKind: 'none',
        manualInstallRecipes: null,
        managedInstall: {
          kind: 'github_release_binary', githubRepo: 'fixture/fixture', binaryName: 'fixture',
          assetNameByPlatform: {
            linux: { x64: assetName, arm64: assetName },
            darwin: { x64: assetName, arm64: assetName },
            win32: { x64: assetName, arm64: assetName },
          },
        },
      },
      platform, env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' }, skipIfInstalled: false,
      onProgress: (event) => events.push(event),
      deps: { fetchGitHubLatestRelease: releaseFails ? (params) => fetchGitHubLatestRelease({
        ...params, fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}/release`, init),
      }) : async () => ({
        tag_name: 'v1', assets: [{ name: assetName, browser_download_url: `http://127.0.0.1:${address.port}/asset`,
          digest: badDigest ? 'sha256:invalid-fixture-digest' : `sha256:${createHash('sha256').update(bytes).digest('hex')}` }],
      }) },
    });
    if (status === 500 || badDigest) {
      expect(result).toMatchObject({ ok: false, errorCode: badDigest ? 'verification-failed' : 'download-failed' });
      await expect(readFile(join(root, 'tools/providers/fixture/current/bin/fixture'))).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    expect(result.ok).toBe(true);
    expect(events).toContainEqual({ t: 'progress', bytesDone: bytes.length, bytesTotal: bytes.length });
    expect(await readFile(join(root, 'tools/providers/fixture/current/bin', process.platform === 'win32' ? 'fixture.exe' : 'fixture'))).toEqual(bytes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])('download reports actual transferred bytes (content length: %s)', async (knownLength) => {
  const root = await mkdtemp(join(tmpdir(), 'acquisition-progress-'));
  const bytes = Buffer.from('small fixture asset');
  const events: unknown[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, knownLength ? { 'content-length': bytes.length } : {});
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const destinationPath = join(root, 'asset');
    await downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${address.port}/asset`,
      destinationPath,
      onProgress: (event) => events.push(event),
    });
    expect(events.at(-1)).toEqual({ t: 'progress', bytesDone: bytes.length, bytesTotal: knownLength ? bytes.length : null });
    expect(await readFile(destinationPath)).toEqual(bytes);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('download abort closes a streaming response and leaves no published asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acquisition-cancel-'));
  const destinationPath = join(root, 'asset');
  const controller = new AbortController();
  let responseClosed = false;
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write('partial');
    res.on('close', () => { responseClosed = true; });
    // A finite fallback makes the missing-cancellation RED fail rather than hang.
    const timer = setTimeout(() => res.end('complete'), 100);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const url = `http://127.0.0.1:${address.port}/asset`;
    const operation = downloadGitHubReleaseAsset({
      url, destinationPath, signal: controller.signal,
      onProgress: (event) => { if (event.t === 'progress' && event.bytesDone > 0) controller.abort(); },
    });
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${destinationPath}.download`)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  expect(responseClosed).toBe(true);
});

test('a canceled raw asset extraction preserves its source and existing destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-cancel-'));
  const archivePath = join(root, 'download');
  const outputPath = join(root, 'binary');
  await writeFile(archivePath, 'new');
  await writeFile(outputPath, 'existing');
  try {
    await expect(extractGitHubReleaseAsset({ archivePath, archiveName: 'binary', extractDir: join(root, 'extract'), outputPath, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(outputPath, 'utf8')).toBe('existing');
    expect(await readFile(archivePath, 'utf8')).toBe('new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Node release lookup cancels its real fetch transport', async () => {
  const controller = new AbortController();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
    controller.abort();
    const timer = setTimeout(() => res.end(']'), 100);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    // The test server substitutes only the external HTTP service.
    const fetchImpl: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init);
    const operation = fetchNodeRuntimeReleaseAsset({ signal: controller.signal, fetchImpl });
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// An unused HTTP body can remain open after headers; acquisition owns closing it.
test.each([302, 500])('download closes a discarded HTTP %s response body', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'acquisition-discarded-response-'));
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/asset') {
      res.end('verified destination');
      return;
    }
    res.on('close', markClosed);
    res.writeHead(status, status === 302 ? { location: '/asset' } : {});
    res.write('unused body stays open');
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const destinationPath = join(root, 'asset');
    const operation = downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${address.port}/discarded`, destinationPath,
    });
    if (status === 302) {
      await operation;
      expect(await readFile(destinationPath, 'utf8')).toBe('verified destination');
    } else {
      await expect(operation).rejects.toMatchObject({ errorCode: 'download-failed' });
    }
    expect(await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => { watchdog = setTimeout(() => resolve(false), 500); }),
    ])).toBe(true);
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
