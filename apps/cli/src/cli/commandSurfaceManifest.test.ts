import { describe, expect, it, vi } from 'vitest';

import {
  isTmuxAllowedCommand,
  listRootHelpCommands,
  primeProjectedCommandSurfaceEntries,
} from './commandSurfaceManifest';
import { buildRootHelpText } from './buildRootHelpText';

const { getResolvedContributionRegistryMock } = vi.hoisted(() => ({
  getResolvedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  getResolvedContributionRegistryMock.mockImplementation(actual.getResolvedContributionRegistry);
  return {
    ...actual,
    getResolvedContributionRegistry: getResolvedContributionRegistryMock,
  };
});

describe('CLI command-surface manifest', () => {
  it('exposes the current root help command list from static and projected command surfaces', async () => {
    await primeProjectedCommandSurfaceEntries();
    const entries = listRootHelpCommands();
    const commands = entries.map((entry) => entry.command);
    expect(commands.slice(0, 22)).toEqual([
      null,
      'setup',
      'auth',
      'automation',
      'mcp',
      'codex',
      'gemini',
      'connect',
      'completion',
      'agents',
      'providers',
      'plugins',
      'notify',
      'install',
      'status',
      'service',
      'doctor',
      'uninstall',
      'self',
      'self-update',
      'session',
      'resume',
    ]);
    expect(new Set(commands.slice(22))).toEqual(new Set([
      'claude',
      'opencode',
      'antigravity',
      'grok',
      'auggie',
      'qwen',
      'kimi',
      'kilo',
      'kiro',
      'cursor',
      'ohMyPi',
      'pi',
      'copilot',
      'coderabbit',
      'deepsec',
    ]));

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
    expect(entries.find((entry) => entry.command === 'resume')).toMatchObject({
      rootHelpLabel: 'happier resume [<session-id-or-prefix>]',
      rootHelpDescription: 'Resume an inactive session',
    });
    expect(entries.find((entry) => entry.command === 'providers')).toMatchObject({
      rootHelpLabel: 'happier providers',
      rootHelpDescription: 'Configure model providers and connections',
    });
    expect(entries.find((entry) => entry.command === 'opencode')).toMatchObject({
      rootHelpLabel: 'happier opencode',
      rootHelpDescription: 'Start OpenCode CLI',
    });
  });

  it('keeps tmux disallow decisions aligned with the command manifest', () => {
    expect(isTmuxAllowedCommand('codex')).toBe(true);
    expect(isTmuxAllowedCommand('resume')).toBe(true);
    expect(isTmuxAllowedCommand('service')).toBe(false);
    expect(isTmuxAllowedCommand('status')).toBe(false);
    expect(isTmuxAllowedCommand('daemon')).toBe(false);
    expect(isTmuxAllowedCommand('session')).toBe(false);
    expect(isTmuxAllowedCommand('sessions')).toBe(false);
    expect(isTmuxAllowedCommand('automation')).toBe(false);
    expect(isTmuxAllowedCommand('provider')).toBe(false);
    expect(isTmuxAllowedCommand('install')).toBe(false);
  });

  it('projects merged provider command entries into the root help surface', async () => {
    getResolvedContributionRegistryMock.mockReturnValue({
      agents: [],
      backends: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {
        'acme.ohmypi': {
          id: 'acme.ohmypi',
          cliSubcommand: 'acme.ohmypi',
          getCliCommandHandler: async () => async () => {},
        },
      },
      agentDefinitionsById: new Map([
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
    await primeProjectedCommandSurfaceEntries();

    const entries = listRootHelpCommands();
    const pluginEntry = entries.find((entry) => entry.command === 'acme.ohmypi');
    expect(pluginEntry).toBeTruthy();
    expect(pluginEntry).toMatchObject({
      command: 'acme.ohmypi',
      rootHelpLabel: 'happier acme.ohmypi',
      allowTmux: true,
    });
  });

  it('uses projected first-party root help metadata for bundled provider commands', async () => {
    getResolvedContributionRegistryMock.mockReturnValue({
      agents: [],
      backends: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {
        opencode: {
          id: 'opencode',
          cliSubcommand: 'opencode',
          getCliCommandHandler: async () => async () => {},
          rootHelpLabel: 'happier opencode',
          rootHelpDescription: 'Start OpenCode through projected metadata',
          allowTmux: false,
        },
      },
      agentDefinitionsById: new Map([
        [
          'opencode',
          {
            id: 'opencode',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
              kindVersion: 1,
              id: 'opencode',
              ownedBackendIds: ['opencode'],
            },
            runtimeSpec: {
              id: 'opencode',
              title: 'OpenCode CLI',
              binaryName: 'opencode',
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
    await primeProjectedCommandSurfaceEntries();

    const entries = listRootHelpCommands().filter((entry) => entry.command === 'opencode');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: 'opencode',
      rootHelpLabel: 'happier opencode',
      rootHelpDescription: 'Start OpenCode through projected metadata',
      allowTmux: false,
    });
    expect(isTmuxAllowedCommand('opencode')).toBe(false);
  });

  // The installers gate every post-install `happier <command>` invocation on the
  // CLI's own root help (scripts/release/installers/install.sh
  // `installed_cli_supports_command_surface`, install.ps1
  // `Test-InstalledCliSupportsCommandSurface`). If `setup` ever stops being
  // listed there, `install --run setup` and the guided first-run handoff both
  // refuse to run, so pin the exact shape those installers look for.
  it('lists the command surfaces the installers gate their post-install handoff on', () => {
    const help = buildRootHelpText();
    const installerGate = (subcommand: string): RegExp =>
      new RegExp(String.raw`^\s*(happier\.exe|happier)\s+${subcommand}\b`, 'mu');

    expect(help).toMatch(installerGate('setup'));
    expect(help).toMatch(installerGate('auth'));
    // A surface the CLI does not advertise must not satisfy the gate, or the
    // check would pass for anything.
    expect(help).not.toMatch(installerGate('definitely-not-a-command'));
  });
});
