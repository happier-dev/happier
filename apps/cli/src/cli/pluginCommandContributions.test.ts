import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ResolvedActionContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';

import { handlePluginCommandCliCommand } from './pluginCommandContributions';
import { resolvePluginCommandProjection } from './pluginCommandProjection';
import {
  findCommandDispatchDescriptor,
  resolveCommandCompletionCandidates,
  resolvePluginCommandTmuxMode,
  synchronizePluginCommandContributions,
} from './commandRegistry';
import { listRootHelpCommands } from './commandSurfaceManifest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { PluginActionContributionV2 } from '@happier-dev/protocol';

type CliPresentationFixture = Readonly<{
  provenance: 'external' | 'first_party';
  pluginId?: string;
  source: ResolvedActionContribution['source'];
  manifestPath?: string;
  sourceSpec?: ResolvedActionContribution['sourceSpec'];
  definition: Readonly<{
    kindVersion: 1; id: string; title: string; description?: string; path: string[];
    action: string; actionId: string; visibility?: 'default' | 'advanced';
    aliases?: string[][];
    tmux?: 'inherit' | 'required' | 'forbidden';
    availability?: PluginActionContributionV2['availability'];
    arguments?: unknown;
  }>;
}>;

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
  aliases?: string[][];
  actionId?: string;
  visibility?: 'default' | 'advanced';
  tmux?: 'inherit' | 'required' | 'forbidden';
  provenance?: 'external' | 'first_party';
}>): CliPresentationFixture {
  const provenance = params.provenance ?? 'external';
  return {
    provenance,
    source: { kind: provenance === 'first_party' ? 'bundled' : 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    ...(provenance === 'external' ? {
      sourceSpec: {
        kind: 'path' as const,
        locator: `/plugins/${params.pluginId}`,
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
    } : {}),
    definition: {
      kindVersion: 1,
      id: params.id,
      title: `${params.pluginId} ${params.id}`,
      path: [...params.path],
      ...(params.aliases ? { aliases: params.aliases } : {}),
      action: params.actionId ?? 'run',
      actionId: params.actionId ?? `${params.pluginId}/run`,
      ...(params.visibility ? { visibility: params.visibility } : {}),
      ...(params.tmux ? { tmux: params.tmux } : {}),
    },
  };
}

function action(params: Readonly<{
  pluginId: string;
  id?: string;
  inputSchema: unknown;
  inputHints?: unknown;
}>): ResolvedActionContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    definition: {
      kindVersion: 1,
      id: params.id ?? 'run',
      title: 'Run',
      safety: 'safe',
      placements: [],
      surfaces: {},
      sideEffectClass: 'write',
      inputSchema: params.inputSchema,
      ...(params.inputHints ? { inputHints: params.inputHints } : {}),
    },
  } as unknown as ResolvedActionContribution;
}

function registry(
  commands: readonly CliPresentationFixture[],
  actions: readonly ResolvedActionContribution[] = [],
): ResolvedContributionRegistry {
  const projected = commands.flatMap((command) => {
    const pluginId = command.pluginId!;
    const input = actions.find((action) => `${action.pluginId}/${action.definition.id}` === command.definition.actionId)?.definition;
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { actions: [{
        id: command.definition.id, title: command.definition.title,
        ...(command.definition.description ? { description: command.definition.description } : {}),
        scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe',
        cli: { path: command.definition.path, aliases: command.definition.aliases, visibility: command.definition.visibility, tmux: command.definition.tmux },
        availability: command.definition.availability,
        ...(input?.inputSchema ? { inputSchema: input.inputSchema } : {}),
        ...(input?.inputHints ? { inputHints: input.inputHints } : {}),
      }] },
    });
    return buildPluginContributionRegistry({ loadedPlugins: [{
      pluginId, manifest, pluginRootPath: '/plugins/' + pluginId, manifestPath: '/plugins/' + pluginId + '/plugin.json',
      daemonEntryPath: '/plugins/' + pluginId + '/daemon.mjs', devDaemonEntryPath: null,
      sourceSpec: { kind: 'path', locator: '/plugins/' + pluginId, trustPolicy: 'local_trusted', installPolicy: 'link' },
    }] }).actions.map((action) => ({ ...action, provenance: command.provenance, source: { kind: 'path' as const } }));
  });
  return createResolvedContributionRegistry({ actions: projected });
}

describe('resolvePluginCommandProjection', () => {
  it('keeps exact qualified identity and deterministically fences reserved, invalid, and colliding paths', () => {
    const projection = resolvePluginCommandProjection({
      registry: registry([
        command({
          pluginId: 'happier.bundled.review',
          id: 'inspect-local-command',
          actionId: 'happier.bundled.review/execute-review-action',
          path: ['review', 'inspect'],
          provenance: 'first_party',
        }),
        command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] }),
        command({ pluginId: 'acme.notes', id: 'inspect', path: ['notes', 'inspect'], visibility: 'advanced' }),
        command({ pluginId: 'acme.reserved', id: 'call', path: ['plugins', 'call'] }),
        command({ pluginId: 'acme.invalid', id: 'call', path: ['Not Canonical', 'call'] }),
        command({ pluginId: 'acme.alpha', id: 'dupe', path: ['shared', 'run'] }),
        command({ pluginId: 'acme.beta', id: 'dupe', path: ['shared', 'run'] }),
      ]),
      reservedRoots: new Set(['plugins', 'status']),
    });

    expect(projection.roots).toEqual(['notes', 'review', 'shared']);
    expect(projection.commands.map((entry) => ({
      qualifiedId: entry.qualifiedId,
      qualifiedActionId: entry.qualifiedActionId,
      path: entry.path,
      status: entry.status,
    }))).toEqual([
      {
        qualifiedId: 'acme.notes/add',
        qualifiedActionId: 'acme.notes/add',
        path: ['notes', 'add'],
        status: 'available',
      },
      {
        qualifiedId: 'acme.notes/inspect',
        qualifiedActionId: 'acme.notes/inspect',
        path: ['notes', 'inspect'],
        status: 'available',
      },
      {
        qualifiedId: 'happier.bundled.review/inspect-local-command',
        qualifiedActionId: 'happier.bundled.review/inspect-local-command',
        path: ['review', 'inspect'],
        status: 'available',
      },
      {
        qualifiedId: 'acme.alpha/dupe',
        qualifiedActionId: 'acme.alpha/dupe',
        path: ['shared', 'run'],
        status: 'ambiguous',
      },
      {
        qualifiedId: 'acme.beta/dupe',
        qualifiedActionId: 'acme.beta/dupe',
        path: ['shared', 'run'],
        status: 'ambiguous',
      },
    ]);
    expect(projection.rootHelpEntries).toEqual([
      expect.objectContaining({ command: 'notes', rootHelpLabel: 'happier notes', allowTmux: true }),
      expect.objectContaining({ command: 'review', rootHelpLabel: 'happier review', allowTmux: true }),
    ]);
    expect(projection.diagnostics.map((entry) => entry.code)).toEqual([
      'plugin_command_path_invalid',
      'plugin_command_path_reserved',
      'plugin_command_path_ambiguous',
      'plugin_command_path_ambiguous',
    ]);
  });

  it('fences both sides of a command leaf/subtree collision instead of letting longest-path dispatch shadow one', () => {
    const projection = resolvePluginCommandProjection({
      registry: registry([
        command({ pluginId: 'acme.notes', id: 'notes-root', path: ['notes'] }),
        command({ pluginId: 'acme.notes', id: 'notes-add', path: ['notes', 'add'] }),
        command({ pluginId: 'acme.tasks', id: 'tasks-list', path: ['tasks', 'list'] }),
      ]),
      reservedRoots: new Set(),
    });

    expect(projection.commands).toEqual([
      expect.objectContaining({
        qualifiedId: 'acme.notes/notes-root',
        status: 'ambiguous',
        unavailableCode: 'plugin_command_path_ambiguous',
      }),
      expect.objectContaining({
        qualifiedId: 'acme.notes/notes-add',
        status: 'ambiguous',
        unavailableCode: 'plugin_command_path_ambiguous',
      }),
      expect.objectContaining({
        qualifiedId: 'acme.tasks/tasks-list',
        status: 'available',
      }),
    ]);
    expect(projection.roots).toEqual(['notes', 'tasks']);
    expect(projection.rootHelpEntries).toEqual([
      expect.objectContaining({ command: 'tasks' }),
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
  it('derives qualified path candidates from the command registry snapshot and removes stale paths', async () => {
    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] }),
      command({ pluginId: 'acme.notes', id: 'archive', path: ['notes', 'archive'] }),
    ]));

    expect(await resolveCommandCompletionCandidates(['notes', 'a'])).toEqual(['add', 'archive']);
    expect(await resolveCommandCompletionCandidates(['notes', 'add', ''])).toEqual(['--help', '--input', '--json']);
    expect(await resolveCommandCompletionCandidates(['notes', 'add', '-'])).toEqual(['--help', '--input', '--json']);

    synchronizePluginCommandContributions(registry([
      command({ pluginId: 'acme.tasks', id: 'list', path: ['note-tasks', 'list'] }),
    ]));
    expect(await resolveCommandCompletionCandidates(['notes', 'a'])).toEqual([]);
    expect(await resolveCommandCompletionCandidates(['note-tasks', 'l'])).toEqual(['list']);
  });

  it('projects exact inherit, required, and forbidden tmux modes from the same command snapshot', async () => {
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
    expect(await resolveCommandCompletionCandidates(['shared', 'r'])).toEqual([]);
  });

  it('uses the command path rather than Action field values when enforcing tmux mode', () => {
    const notes = command({ pluginId: 'acme.notes', id: 'watch', path: ['notes', 'watch'], tmux: 'required' });
    synchronizePluginCommandContributions(registry([notes], [action({
      pluginId: 'acme.notes',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    })]));

    expect(resolvePluginCommandTmuxMode(['notes', 'watch', '--value', 'hello'])).toBe('required');
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

  it('renders leaf help from the command path even when input flags precede --help', async () => {
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes], [action({
      pluginId: 'acme.notes',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'high'] },
          count: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['value'],
        additionalProperties: false,
      },
    })]));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--value', 'hello', '--help'],
        rawArgv: ['happier', 'notes', 'add', '--value', 'hello', '--help'],
        terminalRuntime: null,
      });
      const help = String(output.mock.calls.at(-1)?.[0]);
      expect(help).toContain('Command: acme.notes/add');
      expect(help).toContain('[--value]');
      expect(help).toContain('[--input-json <json>]');
      expect(help).toContain('Alias: --input <json>');
      // The contributed leaf documents its fields through the same shared
      // projection as a built-in command: type, requiredness, choices and range.
      const valueRow = help.split('\n').find((line) => line.includes('--value <value>'));
      expect(valueRow).toContain('[required]');
      expect(help.split('\n').find((line) => line.includes('--priority <value>'))).toContain('low | high');
      expect(help.split('\n').find((line) => line.includes('--count <value>'))).toContain('1–5');
    } finally {
      output.mockRestore();
    }
  });
});

describe('plugin command host registry synchronization', () => {
  it('dispatches a supported command to the applied daemon without activating a CLI runtime', async () => {
    const notes = command({
      pluginId: 'happier.bundled.notes',
      id: 'add-local-command',
      actionId: 'happier.bundled.notes/execute-add-action',
      path: ['notes', 'add'],
      aliases: [['memo', 'add']],
      provenance: 'first_party',
    });
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
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk, encoding, callback) => {
      const completeWrite = typeof encoding === 'function' ? encoding : callback;
      completeWrite?.(null);
      return true;
    }) as typeof process.stdout.write);
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('memo', {
        args: ['memo', 'add', '--input', '{"value":"hello"}', '--json'],
        rawArgv: ['happier', 'memo', 'add', '--input', '{"value":"hello"}', '--json'],
        terminalRuntime: null,
      });

      expect(daemonCommandMock.ensure).toHaveBeenCalledOnce();
      expect(daemonCommandMock.execute).toHaveBeenCalledWith({
        actionId: 'happier.bundled.notes/add-local-command',
        input: { value: 'hello' },
        surface: 'cli',
      });
      expect(runtimeLeaseMock.acquire).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('"kind":"plugin_command"'),
        expect.any(Function),
      );
    } finally {
      output.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('uses the canonical Action schema as the sole semantic input authority', async () => {
    daemonCommandMock.execute.mockReset();
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    const commandWithStaleArguments = {
      ...notes,
      definition: {
        ...notes.definition,
        arguments: {
          type: 'object' as const,
          properties: { legacyValue: { type: 'string' as const } },
          required: ['legacyValue'],
          additionalProperties: false,
        },
      },
    } satisfies CliPresentationFixture;
    const contributionRegistry = registry([commandWithStaleArguments], [action({
      pluginId: 'acme.notes',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    })]);
    daemonCommandMock.resolveRegistry.mockResolvedValue(contributionRegistry);
    daemonCommandMock.execute.mockResolvedValue({ matched: true, result: { ok: true, result: { stored: true } } });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--value', 'hello'],
        rawArgv: ['happier', 'notes', 'add', '--value', 'hello'],
        terminalRuntime: null,
      });
    } finally {
      output.mockRestore();
    }

    expect(daemonCommandMock.execute).toHaveBeenCalledWith(expect.objectContaining({ input: { value: 'hello' } }));
  });

  it('validates whole-input JSON against the canonical Action schema before daemon execution', async () => {
    daemonCommandMock.execute.mockReset();
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes], [action({
      pluginId: 'acme.notes',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    })]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--input', '{}'],
        rawArgv: ['happier', 'notes', 'add', '--input', '{}'],
        terminalRuntime: null,
      });
    } finally {
      error.mockRestore();
      process.exitCode = previousExitCode;
    }

    expect(daemonCommandMock.execute).not.toHaveBeenCalled();
  });

  it('projects canonical Action input away from plugin CLI-owned flags', async () => {
    daemonCommandMock.execute.mockReset();
    daemonCommandMock.execute.mockResolvedValue({ matched: true, result: { ok: true, result: null } });
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes], [action({
      pluginId: 'acme.notes',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        additionalProperties: false,
      },
    })]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--action-input', 'not-a-transport-flag'],
        rawArgv: ['happier', 'notes', 'add', '--action-input', 'not-a-transport-flag'],
        terminalRuntime: null,
      });
    } finally {
      error.mockRestore();
      process.exitCode = previousExitCode;
    }

    expect(daemonCommandMock.execute).toHaveBeenCalledOnce();
    expect(daemonCommandMock.execute).toHaveBeenCalledWith({
      actionId: 'acme.notes/add',
      input: { input: 'not-a-transport-flag' },
      surface: 'cli',
    });
  });

  it('does not interpret help or output flags after the option terminator', async () => {
    daemonCommandMock.execute.mockReset();
    const notes = command({ pluginId: 'acme.notes', id: 'add', path: ['notes', 'add'] });
    daemonCommandMock.resolveRegistry.mockResolvedValue(registry([notes], [action({
      pluginId: 'acme.notes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('notes', {
        args: ['notes', 'add', '--', '--help'],
        rawArgv: ['happier', 'notes', 'add', '--', '--help'],
        terminalRuntime: null,
      });
    } finally {
      log.mockRestore();
      error.mockRestore();
      process.exitCode = previousExitCode;
    }

    expect(log).not.toHaveBeenCalled();
    expect(daemonCommandMock.execute).not.toHaveBeenCalled();
  });

  it('adds and removes one real root surface and makes retained stale handlers fail closed', async () => {
    runtimeLeaseMock.acquire.mockReset();
    daemonCommandMock.ensure.mockClear();
    daemonCommandMock.execute.mockReset();
    daemonCommandMock.resolveRegistry.mockReset();
    const notes = command({
      pluginId: 'happier.bundled.notes',
      id: 'add-local-command',
      actionId: 'happier.bundled.notes/execute-add-action',
      path: ['notes', 'add'],
      provenance: 'first_party',
    });

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
