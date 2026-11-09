import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { ensureManagedPnpmCommand, managedPnpmBinPath } from './managedPnpm.js';
import type { AgentInstallProgressEvent } from './installProgress.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';

function currentArchiveAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-darwin-arm64.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-darwin-x64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linux-arm64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linux-x64.tar.gz';
  throw new Error(`Unsupported binary-safe pnpm bootstrap test platform: ${process.platform}/${process.arch}`);
}

describe('managedPnpm binary-safe bootstrap', () => {
  it.skipIf(process.platform === 'win32' || !['arm64', 'x64'].includes(process.arch))(
    'cancels a partial download, cleans bootstrap state, and installs again with an empty process PATH',
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'happier-managed-pnpm-binary-safe-'));
      const payloadDir = join(rootDir, 'payload');
      const archivePath = join(rootDir, currentArchiveAssetName());
      const originalPath = process.env.PATH;

      await mkdir(join(payloadDir, 'dist'), { recursive: true });
      await writeFile(join(payloadDir, 'pnpm'), '#!/bin/sh\necho managed-pnpm\n', 'utf8');
      await chmod(join(payloadDir, 'pnpm'), 0o755);
      await writeFile(join(payloadDir, 'dist', 'index.js'), 'managed-pnpm-support\n', 'utf8');
      await tar.c(
        {
          cwd: payloadDir,
          file: archivePath,
          gzip: true,
          portable: true,
        },
        ['pnpm', 'dist'],
      );
      const archiveBytes = await readFile(archivePath);
      const digest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
      const events: AgentInstallProgressEvent[] = [];

      let stallDownload = true;
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archiveBytes.length });
        if (!stallDownload) {
          response.end(archiveBytes);
          return;
        }
        response.write(archiveBytes.subarray(0, 10));
        // A finite service-boundary fallback exposes a missing consumer signal without leaking the fixture.
        const timer = setTimeout(() => response.end(archiveBytes.subarray(10)), 100);
        response.on('close', () => clearTimeout(timer));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const address = server.address() as AddressInfo;
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HAPPIER_HOME_DIR: join(rootDir, 'home'),
          HAPPIER_PNPM_BIN: undefined,
          PATH: '',
        };
        process.env.PATH = '';

        let canceledDownloadPath: string | undefined;
        const deps = {
          // Substitute only the external HTTP service; download, extraction and promotion remain real.
          downloadGitHubReleaseAsset: (params: Parameters<typeof downloadGitHubReleaseAsset>[0]) => {
            if (stallDownload) canceledDownloadPath = params.destinationPath;
            return downloadGitHubReleaseAsset({
              ...params,
              url: `http://127.0.0.1:${address.port}/${currentArchiveAssetName()}`,
              digest,
            });
          },
        };
        const controller = new AbortController();
        const reason = new Error('stop pnpm acquisition');
        const byteSamples: number[] = [];
        await expect(ensureManagedPnpmCommand(env, deps, {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.t !== 'progress') return;
            byteSamples.push(event.bytesDone);
            if (event.bytesDone > 0) controller.abort(reason);
          },
        })).rejects.toBe(reason);
        expect(byteSamples.some((bytes) => bytes > 0)).toBe(true);
        expect(byteSamples).not.toContain(archiveBytes.length);
        await expect(stat(managedPnpmBinPath(env))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(env.HAPPIER_HOME_DIR!, 'tools', 'pnpm', 'next'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(env.HAPPIER_HOME_DIR!, 'tools', 'pnpm', '.lock', 'bootstrap.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
        if (!canceledDownloadPath) throw new Error('Expected the canceled HTTP acquisition to start');
        await expect(stat(dirname(canceledDownloadPath))).rejects.toMatchObject({ code: 'ENOENT' });

        stallDownload = false;
        const command = await ensureManagedPnpmCommand(env, deps, { onProgress: (event) => events.push(event) });

        expect(command).toBe(managedPnpmBinPath(env));
        expect(events).toContainEqual({ t: 'progress', bytesDone: archiveBytes.length, bytesTotal: archiveBytes.length });
        await expect(readFile(managedPnpmBinPath(env), 'utf8')).resolves.toContain('managed-pnpm');
        await expect(readFile(join(env.HAPPIER_HOME_DIR!, 'tools', 'pnpm', 'current', 'bin', 'dist', 'index.js'), 'utf8'))
          .resolves.toBe('managed-pnpm-support\n');
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
