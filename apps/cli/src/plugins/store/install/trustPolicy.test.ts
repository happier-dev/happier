import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { resolveLocalPluginInstallTrust } from './trustPolicy';

describe('resolveLocalPluginInstallTrust', () => {
  it('uses the current CLI invoker in development trust recovery guidance', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-trust-workspace-');
    const outsideRoot = await createTempDir('happier-plugin-trust-outside-');
    const pluginRoot = join(outsideRoot, 'plugin');
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'hdev' });

    try {
      await mkdir(pluginRoot, { recursive: true });
      const result = await resolveLocalPluginInstallTrust({
        dev: true,
        pluginRootPath: pluginRoot,
        workspaceRoot,
        defaultTrustPolicy: 'prompt',
        defaultInstallPolicy: 'managed_install',
      });

      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_trust_approval_required',
          message: expect.stringContaining("run 'hdev plugins install . --dev'"),
        }),
      ]);
    } finally {
      envScope.restore();
      await removeTempDir(outsideRoot);
      await removeTempDir(workspaceRoot);
    }
  });

  it('retains happier recovery guidance when the canonical invoker resolves to happier', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-trust-workspace-');
    const outsideRoot = await createTempDir('happier-plugin-trust-outside-');
    const pluginRoot = join(outsideRoot, 'plugin');
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    const originalArgv = [...process.argv];
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: undefined });
    process.argv[1] = 'happier';

    try {
      await mkdir(pluginRoot, { recursive: true });
      const result = await resolveLocalPluginInstallTrust({
        dev: true,
        pluginRootPath: pluginRoot,
        workspaceRoot,
        defaultTrustPolicy: 'prompt',
        defaultInstallPolicy: 'managed_install',
      });

      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_trust_approval_required',
          message: expect.stringContaining("run 'happier plugins install . --dev'"),
        }),
      ]);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      envScope.restore();
      await removeTempDir(outsideRoot);
      await removeTempDir(workspaceRoot);
    }
  });
});
