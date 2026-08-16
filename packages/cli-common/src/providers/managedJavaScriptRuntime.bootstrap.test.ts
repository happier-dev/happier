import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
} from './managedJavaScriptRuntime.js';

describe('ensureManagedJavaScriptRuntimeCommand bootstrap', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('selects the existing skip-links policy for the verified managed Node archive', async () => {
    const homeDir = join(tmpdir(), `happier-managed-runtime-links-${randomUUID()}`);
    tempDirs.push(homeDir);
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };
    const extractGitHubReleaseAsset = vi.fn(async (params: Readonly<{ outputPath: string }>) => {
      const nodePath = process.platform === 'win32'
        ? join(params.outputPath, 'node.exe')
        : join(params.outputPath, 'bin', 'node');
      await mkdir(dirname(nodePath), { recursive: true });
      await writeFile(nodePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') await chmod(nodePath, 0o755);
    });

    const command = await ensureManagedJavaScriptRuntimeCommand(env, {
      fetchNodeRuntimeReleaseAsset: async () => ({
        name: process.platform === 'win32' ? 'node-v25.8.0-win-x64.zip' : 'node-v25.8.0-linux-x64.tar.gz',
        url: 'https://nodejs.org/download/release/v25.8.0/node-runtime',
        digest: 'sha256:fixture',
        tag: 'v25.8.0',
        version: '25.8.0',
        binaryRelativePath: process.platform === 'win32' ? 'node.exe' : join('bin', 'node'),
      }),
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeFile(destinationPath, 'archive fixture', 'utf8');
      },
      extractGitHubReleaseAsset,
    });

    expect(command).toBe(managedJavaScriptRuntimeBinPath(env));
    expect(extractGitHubReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({
      skipTarLinks: true,
    }));
  });

  it('preserves the bootstrap failure and phase instead of silently returning null', async () => {
    const homeDir = join(tmpdir(), `happier-managed-runtime-failure-${randomUUID()}`);
    tempDirs.push(homeDir);
    const archiveError = new Error('unsupported archive entry type: SymbolicLink');

    await expect(ensureManagedJavaScriptRuntimeCommand(
      { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' },
      {
        fetchNodeRuntimeReleaseAsset: async () => ({
          name: 'node-v25.8.0-linux-x64.tar.gz',
          url: 'https://nodejs.org/download/release/v25.8.0/node-runtime',
          digest: 'sha256:fixture',
          tag: 'v25.8.0',
          version: '25.8.0',
          binaryRelativePath: join('bin', 'node'),
        }),
        downloadGitHubReleaseAsset: async ({ destinationPath }) => {
          await writeFile(destinationPath, 'archive fixture', 'utf8');
        },
        extractGitHubReleaseAsset: async () => {
          throw archiveError;
        },
      },
    )).rejects.toMatchObject({
      message: 'Managed JavaScript runtime is unavailable: bootstrap failed',
      cause: archiveError,
    });
  });
});
