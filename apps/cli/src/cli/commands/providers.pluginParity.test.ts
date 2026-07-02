import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

import { handleProvidersCommand } from './providers';

describe('happier providers plugin-provider parity', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    resolveMergedContributionRegistryMock.mockReset();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-providers-plugin-parity-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const pluginProvider = {
      id: 'acme.plugin',
      source: 'plugin' as const,
      definition: {
        id: 'acme.plugin',
      },
      runtimeSpec: {
        kindVersion: 1,
        id: 'acme.plugin',
        title: 'Acme Plugin CLI',
        binaryName: 'acme-plugin',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@acme/plugin-cli',
          binaryName: 'acme-plugin',
        },
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
    };

    resolveMergedContributionRegistryMock.mockResolvedValue({
      providers: [pluginProvider],
      backends: [],
      hookRegistrations: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map([['acme.plugin', pluginProvider]]),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('includes plugin-provided provider CLI rows in providers list JSON output', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_list');
      expect(parsed.data.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'acme.plugin',
            title: 'Acme Plugin CLI',
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('accepts plugin provider ids in providers setup selection', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['setup', '--providers', 'acme.plugin', '--dry-run', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_setup');
      expect(parsed.data.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: 'acme.plugin',
            ok: true,
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('installs a plugin provider via providers install dry-run', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['install', 'acme.plugin', '--dry-run', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_install');
      expect(parsed.data).toEqual(
        expect.objectContaining({
          providerId: 'acme.plugin',
        }),
      );
      expect(parsed.data.plan).toEqual(expect.objectContaining({
        providerId: 'acme.plugin',
        installMode: 'managed_package',
      }));
    } finally {
      output.restore();
    }
  });
});
