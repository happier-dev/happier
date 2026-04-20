import { describe, expect, it, vi } from 'vitest';

import { isTmuxAllowedCommand, listRootHelpCommands } from './commandSurfaceManifest';

const { getResolvedContributionRegistryMock } = vi.hoisted(() => ({
  getResolvedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/extensions/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/registry/createResolvedContributionRegistry')>();
  getResolvedContributionRegistryMock.mockImplementation(actual.getResolvedContributionRegistry);
  return {
    ...actual,
    getResolvedContributionRegistry: getResolvedContributionRegistryMock,
  };
});

describe('CLI command-surface manifest', () => {
  it('exposes the current root help command list from one manifest', () => {
    const entries = listRootHelpCommands();
    expect(entries.map((entry) => entry.command)).toEqual([
      null,
      'setup',
      'auth',
      'mcp',
      'codex',
      'opencode',
      'gemini',
      'connect',
      'providers',
      'plugins',
      'notify',
      'install',
      'service',
      'doctor',
      'uninstall',
      'self',
      'self-update',
      'session',
    ]);

    for (const entry of entries) {
      expect(entry.rootHelpLabel).toBeTypeOf('string');
      expect(entry.rootHelpLabel).toMatch(/^happier\b/u);
    }

    expect(entries.find((entry) => entry.command === 'self')).toMatchObject({
      rootHelpLabel: 'happier self',
      rootHelpDescription: 'Manage CLI updates and release channels',
    });
    expect(entries.find((entry) => entry.command === 'self-update')).toMatchObject({
      rootHelpLabel: 'happier self-update',
      rootHelpDescription: 'Update the Happier CLI',
    });
    expect(entries.find((entry) => entry.command === 'session')).toMatchObject({
      rootHelpLabel: 'happier session',
      rootHelpDescription: 'Manage sessions and execution runs',
    });
  });

  it('keeps tmux disallow decisions aligned with the command manifest', () => {
    expect(isTmuxAllowedCommand('codex')).toBe(true);
    expect(isTmuxAllowedCommand('resume')).toBe(true);
    expect(isTmuxAllowedCommand('service')).toBe(false);
    expect(isTmuxAllowedCommand('daemon')).toBe(false);
    expect(isTmuxAllowedCommand('session')).toBe(false);
    expect(isTmuxAllowedCommand('sessions')).toBe(false);
    expect(isTmuxAllowedCommand('install')).toBe(false);
  });

  it('projects merged provider command entries into the root help surface', async () => {
    getResolvedContributionRegistryMock.mockReturnValue({
      providers: [],
      backends: [],
      hookRegistrations: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {
        'acme.ohmypi': {
          id: 'acme.ohmypi',
          cliSubcommand: 'acme.ohmypi',
          getCliCommandHandler: async () => async () => {},
        },
      },
      providerDefinitionsById: new Map([
        [
          'acme.ohmypi',
          {
            id: 'acme.ohmypi',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
              kindVersion: 1,
              id: 'acme.ohmypi',
              ownedBackendIds: ['acme.ohmypi.acp'],
            },
            runtimeSpec: {
              id: 'acme.ohmypi',
              title: 'Acme Oh My Pi',
              binaryName: 'acme-ohmypi',
              sourcePreferenceDefault: 'system-first',
              managedInstall: null,
              manualInstallKind: 'command',
              manualInstallRecipes: null,
              acceptsJavaScriptFileOverride: false,
            },
          },
        ],
      ]),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });

    const entries = listRootHelpCommands();
    const pluginEntry = entries.find((entry) => entry.command === 'acme.ohmypi');
    expect(pluginEntry).toBeTruthy();
    expect(pluginEntry).toMatchObject({
      command: 'acme.ohmypi',
      rootHelpLabel: 'happier acme.ohmypi',
      allowTmux: true,
    });
  });
});
