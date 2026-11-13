import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ensureManagedJavaScriptRuntimeCommand, managedJavaScriptRuntimeBinPath, managedJavaScriptRuntimeInstallDir } from './managedJavaScriptRuntime.js';

describe('ensureManagedJavaScriptRuntimeCommand bootstrap failures', () => {
  it.each([
    { kind: 'existing', library: 'libatomic.so.1' },
    { kind: 'downloaded', library: 'libatomic.so.1' },
    { kind: 'downloaded', library: 'libstdc++.so.6' },
  ] as const)('reports $library before using a $kind managed Node runtime', async ({ kind, library }) => {
    const homeDir = join(tmpdir(), `happier-managed-runtime-library-${randomUUID()}`);
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };
    const installDir = managedJavaScriptRuntimeInstallDir(env);
    const stage = async (root: string) => {
      const binary = process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node');
      await mkdir(join(root, 'bin'), { recursive: true });
      await writeFile(binary, 'native runtime fixture');
      await chmod(binary, 0o755);
    };
    try {
      if (kind === 'existing') {
        await stage(join(installDir, 'current', 'runtime'));
        await mkdir(join(installDir, 'current', 'bin'), { recursive: true });
        await writeFile(managedJavaScriptRuntimeBinPath(env), 'wrapper fixture');
        await chmod(managedJavaScriptRuntimeBinPath(env), 0o755);
      }
      await expect(ensureManagedJavaScriptRuntimeCommand(env, {
        fetchNodeRuntimeReleaseAsset: async () => ({ name: 'node.tar.gz', url: 'https://nodejs.org/node.tar.gz', digest: 'sha256:fixture',
          tag: 'v25.8.0', version: '25.8.0', binaryRelativePath: process.platform === 'win32' ? 'node.exe' : join('bin', 'node') }),
        downloadGitHubReleaseAsset: async ({ destinationPath }) => { await writeFile(destinationPath, 'archive'); },
        extractGitHubReleaseAsset: async ({ outputPath }) => { await stage(outputPath); },
        // The native loader is the external boundary; install and promotion stay real.
        execFileWithDeadline: async () => { throw Object.assign(new Error('native loader failed'), {
          code: 127, stderr: `node: error while loading shared libraries: ${library}: cannot open shared object file: No such file or directory`,
        }); },
      })).rejects.toMatchObject({ code: 'managed-runtime-unavailable',
        message: expect.stringContaining(library) });
      if (kind === 'downloaded') await expect(stat(join(installDir, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });

  it('preserves the bootstrap failure and phase instead of silently returning null', async () => {
    const homeDir = join(tmpdir(), `happier-managed-runtime-failure-${randomUUID()}`);
    const archiveError = new Error('unsupported archive entry type: SymbolicLink');

    try {
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
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
