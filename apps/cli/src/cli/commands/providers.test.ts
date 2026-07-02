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

describe('happier providers --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    resolveMergedContributionRegistryMock.mockReset();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-providers-json-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    resolveMergedContributionRegistryMock.mockResolvedValue({
      providers: [
        {
          id: 'acme.providers.list',
          source: 'built-in',
          definition: {
            id: 'acme.providers.list',
          },
          runtimeSpec: {
            kindVersion: 1,
            id: 'acme.providers.list',
            title: 'Acme Providers List',
            binaryName: 'acme-providers-list',
            sourcePreferenceDefault: 'system-first',
            managedInstall: {
              kind: 'managed_package',
              packageName: '@acme/providers-list',
              binaryName: 'acme-providers-list',
            },
            manualInstallKind: 'command',
            manualInstallRecipes: null,
            acceptsJavaScriptFileOverride: false,
          },
        },
      ],
      backends: [],
      hookRegistrations: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map(),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('prints a providers_list JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_list');
      expect(Array.isArray(parsed.data?.providers)).toBe(true);
      expect(parsed.data.providers.length).toBeGreaterThan(0);
      const first = parsed.data.providers[0];
      expect(first).toEqual(expect.objectContaining({
        id: 'acme.providers.list',
        title: 'Acme Providers List',
        installed: expect.any(Boolean),
      }));
      expect(first.source === null || typeof first.source === 'string').toBe(true);
      expect(first.command === null || typeof first.command === 'string').toBe(true);
    } finally {
      output.restore();
    }
  });

  it('prints a providers_status JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['status', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_status');
      expect(parsed.data.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'acme.providers.list',
            title: 'Acme Providers List',
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('projects the merged provider registry into the help page', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['help']);
      const text = output.logs.join('\n');
      expect(text).toContain('Available providers:');
      expect(text).toContain('Acme Providers List');
      expect(text).toContain('acme.providers.list');
      expect(text).toContain('happier providers install acme.providers.list');
    } finally {
      output.restore();
    }
  });
});
