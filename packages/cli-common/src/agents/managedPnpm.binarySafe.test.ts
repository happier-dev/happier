import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { ensureManagedPnpmCommand, managedPnpmBinPath } from './managedPnpm.js';

function currentArchiveAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-darwin-arm64.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-darwin-x64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linux-arm64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linux-x64.tar.gz';
  throw new Error(`Unsupported binary-safe pnpm bootstrap test platform: ${process.platform}/${process.arch}`);
}

describe('managedPnpm binary-safe bootstrap', () => {
  it.skipIf(process.platform === 'win32' || !['arm64', 'x64'].includes(process.arch))(
    'extracts a verified current-platform archive with an empty process PATH',
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

      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(archiveBytes);
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

        const command = await ensureManagedPnpmCommand(env, {
          fetchGitHubLatestRelease: async () => ({
            tag_name: 'v10.2.1',
            assets: [{
              name: currentArchiveAssetName(),
              browser_download_url: `http://127.0.0.1:${address.port}/pnpm`,
              digest,
            }],
          }),
        });

        expect(command).toBe(managedPnpmBinPath(env));
        await expect(readFile(managedPnpmBinPath(env), 'utf8')).resolves.toContain('managed-pnpm');
        await expect(readFile(join(env.HAPPIER_HOME_DIR!, 'tools', 'pnpm', 'current', 'bin', 'dist', 'index.js'), 'utf8'))
          .resolves.toBe('managed-pnpm-support\n');
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
