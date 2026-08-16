import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ensureManagedJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';

describe('ensureManagedJavaScriptRuntimeCommand bootstrap failures', () => {
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
