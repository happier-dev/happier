import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';

import {
  handlePluginCommandCliCommand,
  resolvePluginCommandProjection,
} from './pluginCommandContributions';
import {
  findCommandDispatchDescriptor,
  resolveCommandCompletionCandidates,
  resolvePluginCommandTmuxMode,
  synchronizePluginCommandContributions,
} from './commandRegistry';
import { listRootHelpCommands } from './commandSurfaceManifest';

const runtimeLeaseMock = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

const daemonCommandMock = vi.hoisted(() => ({
  ensure: vi.fn(async () => undefined),
  execute: vi.fn(),
  resolveRegistry: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMock.acquire,
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemonCommandMock.ensure,
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonPluginActionExecution: daemonCommandMock.execute,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>(),
  resolveMergedContributionRegistry: daemonCommandMock.resolveRegistry,
}));

function command(params: Readonly<{
  pluginId: string;
  id: string;
  path: readonly string[];
  actionId?: string;
  visibility?: 'default' | 'advanced';
  tmux?: 'inherit' | 'required' | 'forbidden';
}>): ResolvedCommandContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    manifestDigest: `sha256:${params.pluginId}:${params.id}`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      kindVersion: 1,
      id: params.id,
      title: `${params.pluginId} ${params.id}`,
      path: [...params.path],
      action: params.actionId ?? 'run',
      actionId: params.actionId ?? `${params.pluginId}/run`,
      ...(params.visibility ? { visibility: params.visibility } : {}),
      ...(params.tmux ? { tmux: params.tmux } : {}),
    },
  };
}

function registry(commands: readonly ResolvedCommandContribution[]): ResolvedContributionRegistry {
  return {
    generationId: 'registry:commands',
    uiViewsV2: [],
    uiRenderersV2: [],
    uiTranslationsV2: [],
    agents: [],
        actions: [],
    tools: [],
    commands,
    resources: [],
    activationTargets: [],
    actionsById: new Map(),
    toolsById: new Map(),
    commandsById: new Map(commands.map((entry) => [`${entry.pluginId}/${entry.definition.id}`, entry])),
    resourcesById: new Map(),
        catalogEntriesById: {},
    agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
  };
}

describe('resolvePluginCommandProjection', () => {
  it('keeps exact qualified identity and deterministically fences reserved, invalid, and colliding paths', () => {
    const projection = resolvePluginCommandProjection({
      registry: registry([
        command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] }),
        command({ pluginId: 'acme.notes', id: 'inspect', path: ['notes', 'inspect'], visibility: 'advanced' }),
        command({ pluginId: 'acme.reserved', id: 'call', path: ['plugins', 'call'] }),
        command({ pluginId: 'acme.invalid', id: 'call', path: ['Not Canonical', 'call'] }),
        command({ pluginId: 'acme.alpha', id: 'dupe', path: ['shared', 'run'] }),
        command({ pluginId: 'acme.beta', id: 'dupe', path: ['shared', 'run'] }),
      ]),
      reservedRoots: new Set(['plugins', 'status']),
    });

    expect(projection.roots).toEqual(['notes', 'shared']);
    expect(projection.commands.map((entry) => ({
      qualifiedId: entry.qualifiedId,
      qualifiedActionId: entry.qualifiedActionId,
      path: entry.path,
      status: entry.status,
    }))).toEqual([
      {
        qualifiedId: 'acme.notes/add',
        qualifiedActionId: 'acme.notes/run',
        path: ['notes', 'add'],
        status: 'available',
      },
      {
        qualifiedId: 'acme.notes/inspect',
        qualifiedActionId: 'acme.notes/run',
        path: ['notes', 'inspect'],
        status: 'available',
      },
      {
        qualifiedId: 'acme.alpha/dupe',
        qualifiedActionId: 'acme.alpha/run',
        path: ['shared', 'run'],
        status: 'ambiguous',
      },
      {
        qualifiedId: 'acme.beta/dupe',
        qualifiedActionId: 'acme.beta/run',
        path: ['shared', 'run'],
        status: 'ambiguous',
      },
    ]);
    expect(projection.rootHelpEntries).toEqual([
      expect.objectContaining({ command: 'notes', rootHelpLabel: 'happier notes', allowTmux: true }),
    ]);
    expect(projection.diagnostics.map((entry) => entry.code)).toEqual([
      'plugin_command_path_reserved',
      'plugin_command_path_invalid',
      'plugin_command_path_ambiguous',
      'plugin_command_path_ambiguous',
    ]);
  });

  it('evaluates known command facts and fails missing availability facts closed', () => {
    const conditional = command({ pluginId: 'acme.notes', id: 'sync', path: ['notes', 'sync'] });
    const projection = resolvePluginCommandProjection({
      registry: registry([{
        ...conditional,
        definition: {
          ...conditional.definition,
          availability: {
            when: { fact: 'host.feature', operator: 'enabled', value: 'notes.sync' },
          },
        },
      }]),
      reservedRoots: new Set(),
    });

    expect(projection.commands).toEqual([
      expect.objectContaining({
        qualifiedId: 'acme.notes/sync',
        status: 'unavailable',
        unavailableCode: 'plugin_contribution_policy_fact_unavailable',
      }),
    ]);
    expect(projection.rootHelpEntries).toEqual([]);

    const enabledProjection = resolvePluginCommandProjection({
      registry: registry([{
        ...conditional,
        definition: {
          ...conditional.definition,
          availability: {
            when: { fact: 'plugin.enabled', operator: 'equals', value: true },
          },
        },
      }]),
      reservedRoots: new Set(),
    });
    expect(enabledProjection.commands).toEqual([
      expect.objectContaining({ qualifiedId: 'acme.notes/sync', status: 'available' }),
    ]);
  });

  it('neutralizes terminal control and line-breaking text from plugin help metadata', () => {
    const unsafe = command({ pluginId: 'acme.notes', id: 'inspect', path: ['notes', 'inspect'] });
    const projection = resolvePluginCommandProjection({
      registry: registry([{
        ...unsafe,
        definition: {
          ...unsafe.definition,
          title: '\u001b]52;c;Y29weQ==\u0007Inspect\nnotes',
          description: 'Review\r\nchanges\u202e',
        },
      }]),
      reservedRoots: new Set(),
    });

    expect(projection.commands).toEqual([
      expect.objectContaining({
        title: 'Inspect notes',
        description: 'Review changes',
      }),
    ]);
    expect(JSON.stringify(projection.rootHelpEntries)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
  });

});

describe('plugin command completion snapshot', () => {
  it('derives qualified path candidates from the command registry snapshot and removes stale paths', () => {
    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] }),
      command({ pluginId: 'acme.notes', id: 'archive', path: ['notes', 'archive'] }),
    ]));

    expect(resolveCommandCompletionCandidates(['notes', 'a'])).toEqual(['add', 'archive']);
    expect(resolveCommandCompletionCandidates(['notes', 'add', ''])).toEqual(['--help', '--input', '--json']);
    expect(resolveCommandCompletionCandidates(['notes', 'add', '-'])).toEqual(['--help', '--input', '--json']);

    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.tasks', id: 'list', path: ['tasks', 'list'] }),
    ]));
    expect(resolveCommandCompletionCandidates(['notes', 'a'])).toEqual([]);
    expect(resolveCommandCompletionCandidates(['tasks', 'l'])).toEqual(['list']);
  });

  it('projects exact inherit, required, and forbidden tmux modes from the same command snapshot', () => {
    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.notes', id: 'read', path: ['notes', 'read'] }),
      command({ pluginId: 'acme.notes', id: 'watch', path: ['notes', 'watch'], tmux: 'required' }),
      command({ pluginId: 'acme.notes', id: 'write', path: ['notes', 'write'], tmux: 'forbidden' }),
    ]));
    expect(resolvePluginCommandTmuxMode(['notes', 'read'])).toBe('inherit');
    expect(resolvePluginCommandTmuxMode(['notes', 'watch', '--input', '{"value":"C:\\\\tmp"}'])).toBe('required');
    expect(resolvePluginCommandTmuxMode(['notes', 'write', '--json'])).toBe('forbidden');

    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.alpha', id: 'dupe', path: ['shared', 'run'], tmux: 'inherit' }),
      command({ pluginId: 'acme.beta', id: 'dupe', path: ['shared', 'run'], tmux: 'required' }),
    ]));
    expect(resolvePluginCommandTmuxMode(['shared', 'run'])).toBe('forbidden');
    expect(resolveCommandCompletionCandidates(['shared', 'r'])).toEqual([]);
  });
});

describe('handlePluginCommandCliCommand help', () => {
  beforeEach(() => {
    runtimeLeaseMock.acquire.mockReset();
    daemonCommandMock.ensure.mockClear();
    daemonCommandMock.execute.mockReset();
    daemonCommandMock.resolveRegistry.mockReset();
  });

  it('executes a schema-valid root-only command instead of replacing it with namespace help', async () => {
    const notes = command({ pluginId: 'acme.beta', id: 'notes-root', path: ['notes'] });
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes]));
    daemonCommandMock.execute.mockResolvedValue({
      matched: true,
      result: { ok: true, result: { owner: 'beta' } },
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes'],
        rawArgv: ['happier', 'notes'],
        terminalRuntime: null,
      });
    } finally {
      output.mockRestore();
    }

    expect(daemonCommandMock.execute).toHaveBeenCalledOnce();
    expect(runtimeLeaseMock.acquire).not.toHaveBeenCalled();
  });

  it('keeps advanced commands out of root help and labels explicitly requested unavailable commands', async () => {
    const normal = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    const advanced = command({
      pluginId: 'acme.notes',
      id: 'inspect',
      path: ['notes', 'inspect'],
      visibility: 'advanced',
    });
    const conditional = command({ pluginId: 'acme.notes', id: 'sync', path: ['notes', 'sync'] });
    const contributionRegistry = registry([
      normal,
      advanced,
      {
        ...conditional,
        definition: {
          ...conditional.definition,
          availability: {
            when: { fact: 'host.feature', operator: 'enabled', value: 'notes.sync' },
          },
        },
      },
    ]);
    daemonCommandMock.resolveRegistry.mockResolvedValue(contributionRegistry);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', '--help'],
        rawArgv: ['happier', 'notes', '--help'],
        terminalRuntime: null,
      });
      expect(String(output.mock.calls.at(-1)?.[0])).toContain('add');
      expect(String(output.mock.calls.at(-1)?.[0])).not.toContain('inspect');
      expect(String(output.mock.calls.at(-1)?.[0])).not.toContain('sync');

      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'sync', '--help'],
        rawArgv: ['happier', 'notes', 'sync', '--help'],
        terminalRuntime: null,
      });
      expect(String(output.mock.calls.at(-1)?.[0])).toContain(
        'Unavailable: plugin_contribution_policy_fact_unavailable',
      );
    } finally {
      output.mockRestore();
    }
    expect(runtimeLeaseMock.acquire).not.toHaveBeenCalled();
  });
});

describe('plugin command host registry synchronization', () => {
  it('dispatches a supported command to the applied daemon without activating a CLI runtime', async () => {
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    daemonCommandMock.ensure.mockClear();
    daemonCommandMock.execute.mockReset();
    daemonCommandMock.resolveRegistry.mockReset();
    runtimeLeaseMock.acquire.mockReset();
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes]));
    daemonCommandMock.execute.mockResolvedValue({
      matched: true,
      result: { ok: true, result: { stored: 'hello' } },
    });
    runtimeLeaseMock.acquire.mockRejectedValue(new Error('CLI runtime activation is forbidden'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--input', '{"value":"hello"}', '--json'],
        rawArgv: ['happier', 'notes', 'add', '--input', '{"value":"hello"}', '--json'],
        terminalRuntime: null,
      });

      expect(daemonCommandMock.ensure).toHaveBeenCalledOnce();
      expect(daemonCommandMock.execute).toHaveBeenCalledWith({
        actionId: 'acme.notes/run',
        input: { value: 'hello' },
        surface: 'cli',
      });
      expect(runtimeLeaseMock.acquire).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"kind":"plugin_command"'));
    } finally {
      output.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('adds and removes one real root surface and makes retained stale handlers fail closed', async () => {
    runtimeLeaseMock.acquire.mockReset();
    daemonCommandMock.ensure.mockClear();
    daemonCommandMock.execute.mockReset();
    daemonCommandMock.resolveRegistry.mockReset();
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });

    synchronizePluginCommandContributions(registry([notes]));
    const retained = findCommandDispatchDescriptor('notes');
    expect(retained).toMatchObject({ id: 'notes', command: 'notes' });
    expect(listRootHelpCommands()).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'notes', rootHelpLabel: 'happier notes' }),
    ]));

    synchronizePluginCommandContributions(registry([]));
    expect(findCommandDispatchDescriptor('notes')).toBeNull();
    expect(listRootHelpCommands().some((entry) => entry.command === 'notes')).toBe(false);

    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await retained!.handler({ args: ['notes', 'add'], rawArgv: ['happier', 'notes', 'add'], terminalRuntime: null });
      expect(error).toHaveBeenCalledOnce();
      expect(runtimeLeaseMock.acquire).not.toHaveBeenCalled();
      expect(daemonCommandMock.execute).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
