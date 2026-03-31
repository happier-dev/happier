import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { getProviderCliSetupRecommendedIds } from '@happier-dev/agents';

const invokeProviderCliInstall = vi.fn(async (_params: Readonly<{ agentId: string }>) => ({
  ok: true as const,
  alreadyInstalled: false,
  plan: { installMode: 'managed_package' } as any,
  logPath: null,
}));

vi.mock('@/runtime/managedTools/invokeProviderCliInstall', () => ({
  invokeProviderCliInstall,
}));

import { handleProvidersCommand } from './providers';

describe('happier providers setup --yes --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    invokeProviderCliInstall.mockReset();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-providers-setup-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('installs recommended providers without prompting', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['setup', '--yes', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_setup');
      expect(Array.isArray(parsed.data?.providers)).toBe(true);
      expect(parsed.data.providers.length).toBeGreaterThan(0);

      const installedIds = invokeProviderCliInstall.mock.calls.map((call) => call[0].agentId);
      expect(installedIds).toEqual([...getProviderCliSetupRecommendedIds()]);
    } finally {
      output.restore();
    }
  });

  it('accepts --providers comma-separated selection in non-interactive mode', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['setup', '--providers', 'claude,codex', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);

      const installedIds = invokeProviderCliInstall.mock.calls.map((call) => call[0].agentId);
      expect(installedIds).toEqual(['claude', 'codex']);
    } finally {
      output.restore();
    }
  });

  it('rejects unsupported provider ids such as customAcp', async () => {
    await expect(handleProvidersCommand(['setup', '--providers', 'customAcp', '--json'])).rejects.toThrow(
      /Unsupported provider id\(s\) for setup/i,
    );
  });
});
