import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureManagedUvCommand, managedUvBinPath } from './managedUv.js';

const network = vi.hoisted(() => ({ origin: '' }));
// Only upstream HTTPS is redirected; the digest downloader remains real.
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) {
    if (url.hostname !== 'releases.astral.sh' || !network.origin) throw new Error('Unexpected release transport');
    return httpRequest(new URL(url.pathname, network.origin), options, callback);
  },
}));
afterEach(() => { network.origin = ''; vi.unstubAllEnvs(); });

describe('managed uv acquisition', () => {
  beforeEach(() => {
    // Both install-lock contenders belong to this fixture, independently of the worker's build admission.
    vi.stubEnv('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED', '1');
  });
  it.skipIf(process.platform === 'win32')('extracts the pinned asset through the existing acquisition owner and reuses concurrent installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p9d-uv-bootstrap-'));
    const env = { HAPPIER_HOME_DIR: root, PATH: '' };
    let downloads = 0;
    try {
      // Fixture the actual external downloader boundary. Archive extraction,
      // executable admission, lock/reuse and promotion remain real.
      const deps = { downloadGitHubReleaseAsset: async (params: { url: string; destinationPath: string; digest?: string | null }) => {
        downloads++;
        expect(params.url).toContain('/releases/download/0.13.0/uv-');
        expect(params.url).not.toContain('api.github.com');
        expect(params.digest).toMatch(/^[a-f0-9]{64}$/);
        const folder = basename(params.destinationPath).replace(/\.tar\.gz$/, '');
        const payload = join(root, 'payload', folder);
        await mkdir(payload, { recursive: true });
        await writeFile(join(payload, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await mkdir(dirname(params.destinationPath), { recursive: true });
        await tar.c({ cwd: dirname(payload), file: params.destinationPath, gzip: true, portable: true }, [folder]);
      } };
      const commands = await Promise.all([ensureManagedUvCommand(env, deps), ensureManagedUvCommand(env, deps)]);
      expect(commands).toEqual([managedUvBinPath(env), managedUvBinPath(env)]);
      expect(await readFile(commands[0]!, 'utf8')).toContain('exit 0');
      expect(downloads).toBe(1);
      expect(await ensureManagedUvCommand(env, { downloadGitHubReleaseAsset: async () => { throw new Error('Unexpected download'); } })).toBe(commands[0]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on a real digest mismatch and never promotes downloaded bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p9d-uv-digest-'));
    const fixture = createServer((_request, response) => response.end('corrupt upstream archive'));
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    network.origin = `http://127.0.0.1:${address.port}`;
    const env = { HAPPIER_HOME_DIR: root, PATH: '' };
    try {
      expect(await ensureManagedUvCommand(env)).toBeNull();
      await expect(access(managedUvBinPath(env))).rejects.toMatchObject({ code: 'ENOENT' });
      const controller = new AbortController(); controller.abort();
      await expect(ensureManagedUvCommand(env, {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
