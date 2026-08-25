import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  PluginProjectedActionV2Schema,
  type PluginProjectedActionV2,
} from '@happier-dev/protocol';

import type { Command } from './types';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type {
  PluginProjectionAction,
  PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
  createPluginContributedActionController,
  type PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';
import { buildCommandPaletteCommands } from './buildCommandPaletteCommands';

const createSessionActionDraftSpy = vi.fn();
const pluginActionModalAlert = vi.hoisted(() => vi.fn());
let mockedState: any = null;
vi.mock('@/modal', () => ({
  Modal: {
    alert: pluginActionModalAlert,
  },
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => mockedState,
  },
});
});

function commandTitles(cmds: readonly Command[]): string[] {
  return cmds.map((c) => c.title);
}

function buildSettingsWithExecutionRunsEnabled() {
  return {
    experiments: true,
    featureToggles: {
      'execution.runs': true,
    },
  };
}

const PLUGIN_ID = 'acme.commands';
const MACHINE_ID = 'machine-command-palette';
const SERVER_ID = 'server-command-palette';

/** Keep the presentation fixture paired with the authoritative raw Action descriptor. */
function projectedDaemonAction(
  pluginId: string,
  action: PluginProjectionAction,
): PluginProjectedActionV2 | null {
  const projected = PluginProjectedActionV2Schema.safeParse({
    id: action.id,
    pluginId,
    title: action.title,
    ...(action.description ? { description: action.description } : {}),
    ...(action.icon ? { icon: action.icon } : {}),
    scopes: action.scopes,
    surfaces: action.surfaces,
    execution: { target: 'daemon' },
    ...(action.placementBindings.length > 0 ? { placementBindings: action.placementBindings } : {}),
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
    ...(action.inputHints ? { inputHints: action.inputHints } : {}),
    ...(action.slash ? { slash: action.slash } : {}),
    priority: action.priority ?? 0,
    dangerLevel: action.dangerLevel,
    ...(action.confirmation ? { confirmation: action.confirmation } : {}),
    ...(action.available === null ? {} : { available: action.available }),
  });
  return projected.success ? projected.data : null;
}

function pluginAction(input: Partial<PluginProjectionAction> & Readonly<{
  id: string;
}>): PluginProjectionAction {
  return {
    id: input.id,
    title: input.title ?? input.id,
    description: input.description ?? null,
    icon: input.icon ?? null,
    scopes: input.scopes ?? ['session'],
    surfaces: input.surfaces ?? ['ui'],
    placementBindings: input.placementBindings ?? ['commandPalette'],
    inputSchema: input.inputSchema ?? null,
    inputHints: input.inputHints ?? null,
    slash: input.slash ?? null,
    priority: input.priority ?? null,
    dangerLevel: input.dangerLevel ?? 'safe',
    confirmation: input.confirmation ?? null,
    available: input.available ?? true,
  };
}

function pluginEntry(
  actions: readonly PluginProjectionAction[],
  generation: number,
): PluginProjectionEntry {
  return {
    pluginId: PLUGIN_ID,
    immutableGenerationId: `generation-${generation}`,
    title: 'Acme commands',
    description: null,
    version: '1.0.0',
    enabled: true,
    generation,
    generationLabel: String(generation),
    status: null,
    provenance: null,
    diagnostics: [],
    actions,
    resources: [],
    editableSettingsGroups: [],
  };
}

function pluginActionSnapshot(input: Readonly<{
  actions: readonly PluginProjectionAction[];
  generation?: number;
  sessionId?: string;
}>): PluginContributedActionCurrentSnapshot {
  const generation = input.generation ?? 7;
  const actionsById = new Map(input.actions.map((action) => [action.id, action] as const));
  return {
    pluginProjectionById: {
      [PLUGIN_ID]: pluginEntry(input.actions, generation),
    },
    resolveContributedAction: (identity) => {
      if (identity.pluginId !== PLUGIN_ID) return null;
      const action = actionsById.get(identity.localId);
      return action ? projectedDaemonAction(PLUGIN_ID, action) : null;
    },
    host: {
      machineId: MACHINE_ID,
      serverId: SERVER_ID,
      expectedGeneration: generation,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      isCurrent: () => true,
    },
  };
}

function buildCommandsWithPluginActions(input: Readonly<{
  controller: ReturnType<typeof createPluginContributedActionController>;
  scope: 'global' | 'session';
}>): Command[] {
  mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
  return buildCommandPaletteCommands({
    sessionsById: {},
    isDev: false,
    activeSessionId: input.scope === 'session' ? 'session-command-palette' : null,
    features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
    nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
    auth: { logout: async () => {} },
    actions: { execute: async () => ({ ok: true, result: {} }) },
    alert: async () => {},
    pluginActionPresentation: {
      controller: input.controller,
      scope: input.scope,
    },
  });
}

describe('buildCommandPaletteCommands', () => {
  it('delegates the new-session command to the caller-owned ordinary-entry callback', async () => {
    const openNewSession = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const commands = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: vi.fn(),
        openNewSession,
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    await commands.find((command) => command.id === 'new-session')?.action();

    expect(openNewSession).toHaveBeenCalledTimes(1);
  });

  it('omits hidden system sessions before selecting recent session commands', () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const commands = buildCommandPaletteCommands({
      sessionsById: {
        'voice-history-hidden': {
          id: 'voice-history-hidden',
          updatedAt: 200,
          metadataLayoutVersion: 1,
          metadataUnavailable: false,
          metadata: {
            name: 'Voice History carrier',
            systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
          },
        },
        'ordinary-recent': {
          id: 'ordinary-recent',
          updatedAt: 100,
          metadata: { name: 'Ordinary recent session' },
        },
      },
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(commands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-voice-history-hidden' }),
    ]));
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-ordinary-recent' }),
    ]));
  });

  it('projects an admitted command-palette Action with its canonical presentation and executor', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, result: { applied: true } }));
    const controller = createPluginContributedActionController({
      resolveCurrent: () => pluginActionSnapshot({
        sessionId: 'session-command-palette',
        actions: [pluginAction({
          id: 'sync-notes',
          title: 'Sync notes',
          description: 'Synchronize the current notes',
          icon: 'magic-wand',
        })],
      }),
      dispatch,
    });

    const command = buildCommandsWithPluginActions({ controller, scope: 'session' })
      .find((candidate) => candidate.id === 'plugin-action:acme.commands/sync-notes');

    expect(command).toMatchObject({
      title: 'Sync notes',
      subtitle: 'Synchronize the current notes · acme.commands/sync-notes',
      icon: 'magic-wand',
      category: 'acme.commands',
    });

    await command?.action();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      action: { pluginId: PLUGIN_ID, localId: 'sync-notes' },
      contributedAction: {
        machineId: MACHINE_ID,
        serverId: SERVER_ID,
        expectedGeneration: '7',
        sessionId: 'session-command-palette',
      },
    }));
  });

  it('keeps unavailable Actions absent and projects them once the canonical catalog remediates availability', () => {
    let current = pluginActionSnapshot({
      sessionId: 'session-command-palette',
      actions: [pluginAction({ id: 'repair-notes', title: 'Repair notes', available: false })],
    });
    const controller = createPluginContributedActionController({
      resolveCurrent: () => current,
    });

    expect(buildCommandsWithPluginActions({ controller, scope: 'session' }))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'plugin-action:acme.commands/repair-notes' }),
      ]));

    current = pluginActionSnapshot({
      sessionId: 'session-command-palette',
      actions: [pluginAction({ id: 'repair-notes', title: 'Repair notes' })],
    });

    expect(buildCommandsWithPluginActions({ controller, scope: 'session' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'plugin-action:acme.commands/repair-notes' }),
      ]));
  });

  it('refreshes command-palette presentation and removes an uninstalled Action from the current catalog', () => {
    let current = pluginActionSnapshot({
      sessionId: 'session-command-palette',
      actions: [pluginAction({ id: 'sync-notes', title: 'Sync notes' })],
    });
    const controller = createPluginContributedActionController({
      resolveCurrent: () => current,
    });

    expect(buildCommandsWithPluginActions({ controller, scope: 'session' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-action:acme.commands/sync-notes',
          title: 'Sync notes',
        }),
      ]));

    current = pluginActionSnapshot({
      sessionId: 'session-command-palette',
      actions: [pluginAction({ id: 'sync-notes', title: 'Synchronize notes' })],
    });

    expect(buildCommandsWithPluginActions({ controller, scope: 'session' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-action:acme.commands/sync-notes',
          title: 'Synchronize notes',
        }),
      ]));

    current = pluginActionSnapshot({
      generation: 8,
      sessionId: 'session-command-palette',
      actions: [],
    });

    expect(buildCommandsWithPluginActions({ controller, scope: 'session' }))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'plugin-action:acme.commands/sync-notes' }),
      ]));
  });

  it('uses the host-selected session or global Action scope without choosing a first scope', () => {
    const controller = createPluginContributedActionController({
      resolveCurrent: () => pluginActionSnapshot({
        sessionId: 'session-command-palette',
        actions: [
          pluginAction({ id: 'session-action', title: 'Session action', scopes: ['session'] }),
          pluginAction({ id: 'global-action', title: 'Global action', scopes: ['global'] }),
        ],
      }),
    });

    const sessionCommands = buildCommandsWithPluginActions({ controller, scope: 'session' });
    const globalCommands = buildCommandsWithPluginActions({ controller, scope: 'global' });

    expect(sessionCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin-action:acme.commands/session-action' }),
    ]));
    expect(sessionCommands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin-action:acme.commands/global-action' }),
    ]));
    expect(globalCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin-action:acme.commands/global-action' }),
    ]));
    expect(globalCommands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin-action:acme.commands/session-action' }),
    ]));
  });

  it('refuses a palette command after its Action retires with the generation', async () => {
    pluginActionModalAlert.mockClear();
    const dispatch = vi.fn(async () => ({ ok: true as const, result: { applied: true } }));
    let current = pluginActionSnapshot({
      sessionId: 'session-command-palette',
      actions: [pluginAction({ id: 'retiring-action', title: 'Retiring action' })],
    });
    const controller = createPluginContributedActionController({
      resolveCurrent: () => current,
      dispatch,
    });
    const command = buildCommandsWithPluginActions({ controller, scope: 'session' })
      .find((candidate) => candidate.id === 'plugin-action:acme.commands/retiring-action');

    current = pluginActionSnapshot({
      generation: 8,
      sessionId: 'session-command-palette',
      actions: [],
    });
    await command?.action();

    expect(dispatch).not.toHaveBeenCalled();
    expect(pluginActionModalAlert).toHaveBeenCalledOnce();
  });

  it('delegates every compact catalog destination to its host activation owner without collapsing qualified plugin pages', async () => {
    const pushes: string[] = [];
    const compactActivations: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const compactDestinations = [
      {
        kind: 'builtin',
        id: 'browseExistingSessions',
        title: 'Browse existing sessions',
        icon: 'folder-open',
        group: 'sessions',
        order: 0,
        routePath: '/external/browse',
        availability: 'available',
      },
      {
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Acme notes',
        icon: 'note',
        group: 'plugins',
        order: 10,
        routePath: '/plugins/acme.notes/notes',
        availability: 'available',
      },
      {
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:beta.notes:notes',
        destination: { pluginId: 'beta.notes', localId: 'notes' },
        title: 'Beta notes',
        icon: 'note',
        group: 'plugins',
        order: 20,
        routePath: '/plugins/beta.notes/notes',
        availability: 'unavailable',
        unavailableReason: 'plugin_disabled',
      },
    ] as const;
    const input = {
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: (path: string) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
      compactAppDestinations: compactDestinations,
      onActivateCompactAppDestination: (destination: CompactAppDestination) => {
        compactActivations.push(destination.id);
      },
    };

    const commands = buildCommandPaletteCommands(input);
    const destinationCommands = commands.filter((command) => command.id.startsWith('app-destination:'));

    expect(destinationCommands.map((command) => command.id)).toEqual([
      'app-destination:browseExistingSessions',
      'app-destination:plugin:acme.notes:notes',
      'app-destination:plugin:beta.notes:notes',
    ]);
    const unavailableDestinationCommand = destinationCommands.find((command) => (
      command.id === 'app-destination:plugin:beta.notes:notes'
    ));
    expect(unavailableDestinationCommand?.subtitle).toEqual(expect.any(String));
    expect(unavailableDestinationCommand?.subtitle).not.toBe('plugin_disabled');

    for (const command of destinationCommands) {
      await command.action();
    }
    expect(compactActivations).toEqual([
      'browseExistingSessions',
      'plugin:acme.notes:notes',
      'plugin:beta.notes:notes',
    ]);
    expect(pushes).toEqual([]);
  });

  it('does not republish compact destinations the user hid in the canonical catalog', () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const commands = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
      compactAppDestinations: [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:hidden',
        destination: { pluginId: 'acme.notes', localId: 'hidden' },
        title: 'Hidden notes',
        icon: 'note',
        group: 'plugins',
        order: 10,
        routePath: '/plugins/acme.notes/hidden',
        availability: 'available',
        visibility: 'hidden',
      }],
      onActivateCompactAppDestination: () => {},
    });

    expect(commands.some((command) => command.id === 'app-destination:plugin:acme.notes:hidden')).toBe(false);
  });

  it('includes ActionSpec-derived commands when enabled (execution runs + voice)', async () => {
    const pushes: string[] = [];
    const executorCalls: Array<{ actionId: string }> = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: true, memorySearchEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: {
        logout: async () => {},
      },
      actions: {
        execute: async (actionId) => {
          executorCalls.push({ actionId });
          return { ok: true, result: {} };
        },
      },
      alert: async () => {},
    });

    expect(commandTitles(cmds)).toEqual(
      expect.arrayContaining([
        'Start review run',
        'Start plan run',
        'Start delegation run',
        'Open session runs',
        'Reset voice agent',
      ]),
    );

    const reset = cmds.find((c) => c.title === 'Reset voice agent');
    expect(reset).toBeTruthy();
    await reset!.action();
    expect(executorCalls).toEqual([{ actionId: 'ui.voice_global.reset' }]);

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();
    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalled();
  });

  it('shows an alert when a session-scoped ActionSpec command is used without an active session', async () => {
    const alerts: Array<{ title: string; message: string }> = [];
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async (title, message) => {
        alerts.push({ title, message });
      },
    });

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();

    await startReview!.action();
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.title).toContain('Session required');
    expect(pushes).toEqual([]);
  });

  it('keeps review engine selection explicit and does not inject coderabbit-specific config into review.start drafts', async () => {
    createSessionActionDraftSpy.mockClear();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': { id: 'session-1', metadata: { agent: 'coderabbit', name: 'x' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();

    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalledTimes(1);

    const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
    const created = call[1] as any;
    expect(created?.actionId).toBe('review.start');
    expect(created?.input?.engineIds).toBeUndefined();
    expect(created?.input?.engines).toBeUndefined();
  });

  it('uses UI-normalized permission defaults for execution-run drafts', async () => {
    createSessionActionDraftSpy.mockClear();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': { id: 'session-1', metadata: { agent: 'codex', name: 'x' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const expectations: Array<Readonly<{ title: string; actionId: string; permissionMode: string }>> = [
      { title: 'Start review run', actionId: 'review.start', permissionMode: 'read-only' },
      { title: 'Start plan run', actionId: 'subagents.plan.start', permissionMode: 'read-only' },
      { title: 'Start delegation run', actionId: 'subagents.delegate.start', permissionMode: 'safe-yolo' },
    ];

    for (const expected of expectations) {
      createSessionActionDraftSpy.mockClear();
      const command = cmds.find((entry) => entry.title === expected.title);
      expect(command).toBeTruthy();
      await command!.action();

      expect(createSessionActionDraftSpy).toHaveBeenCalledTimes(1);
      const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
      const created = call[1] as any;
      expect(created?.actionId).toBe(expected.actionId);
      expect(created?.input?.permissionMode).toBe(expected.permissionMode);
    }
  });

  it('preserves configured ACP backend targets for plan run drafts', async () => {
    createSessionActionDraftSpy.mockClear();
    mockedState = {
      createSessionActionDraft: createSessionActionDraftSpy,
      settings: {
        ...buildSettingsWithExecutionRunsEnabled(),
        backendEnabledByTargetKey: {
          'agent:claude': true,
        },
      },
    };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': {
          id: 'session-1',
          metadata: {
            flavor: 'customAcp',
            acpConfiguredBackendV1: {
              v: 1,
              updatedAt: 1,
              backendId: 'review-bot',
              title: 'Review Bot',
            },
          },
        },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const startPlan = cmds.find((c) => c.title === 'Start plan run');
    expect(startPlan).toBeTruthy();

    await startPlan!.action();
    const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
    const created = call[1] as any;
    expect(created?.actionId).toBe('subagents.plan.start');
    expect(created?.input?.backendTargetKeys).toEqual(['acpBackend:review-bot']);
  });

  it('omits command_palette actions when disabled for that placement', async () => {
    mockedState = {
      createSessionActionDraft: createSessionActionDraftSpy,
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'review.start': { disabledPlacements: ['command_palette'] },
          },
        },
      },
    };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(commandTitles(cmds)).not.toEqual(expect.arrayContaining(['Start review run']));
  });

  it('includes a memory search navigation command when enabled', async () => {
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: true },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const cmd = cmds.find((c) => c.id === 'memory-search');
    expect(cmd).toBeTruthy();
    await cmd!.action();
    expect(pushes).toEqual(['/search']);
  });

  it('uses effective registry shortcut labels and omits stale display-only labels', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      shortcutLabels: {
        'session.new': 'Cmd+P',
      },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.find((command) => command.id === 'new-session')?.shortcut).toBe('Cmd+P');
    expect(cmds.find((command) => command.id === 'settings')?.shortcut).toBeUndefined();
    expect(cmds.some((command) => command.shortcut === '⌘N' || command.shortcut === '⌘,')).toBe(false);
  });

  it('omits the memory search navigation command when disabled', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.some((c) => c.id === 'memory-search')).toBe(false);
  });

  it('navigates to the terminal QR scanner from the connect terminal command', async () => {
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const cmd = cmds.find((c) => c.id === 'connect');
    expect(cmd).toBeTruthy();
    await cmd!.action();
    expect(pushes).toEqual(['/scan/terminal']);
  });

  it('registers pet commands when the companion feature is enabled', async () => {
    const pushes: string[] = [];
    const wake = vi.fn();
    const tuck = vi.fn();
    const resetPosition = vi.fn();
    const refreshCodexPets = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: {
        executionRunsEnabled: false,
        voiceEnabled: false,
        memorySearchEnabled: false,
        petsCompanionEnabled: true,
      },
      petControls: {
        surface: 'desktopOverlay',
        wake,
        tuck,
        resetPosition,
        refreshCodexPets,
      },
      nav: {
        push: (path: string) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.map((command) => command.id)).toEqual(expect.arrayContaining([
      'pet-wake',
      'pet-tuck',
      'pet-reset-position',
      'ui.pet.choose',
      'pet-refresh-codex',
    ]));

    await cmds.find((command) => command.id === 'pet-wake')!.action();
    await cmds.find((command) => command.id === 'pet-tuck')!.action();
    await cmds.find((command) => command.id === 'pet-reset-position')!.action();
    await cmds.find((command) => command.id === 'pet-refresh-codex')!.action();
    await cmds.find((command) => command.id === 'ui.pet.choose')!.action();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(tuck).toHaveBeenCalledTimes(1);
    expect(resetPosition).toHaveBeenCalledTimes(1);
    expect(refreshCodexPets).toHaveBeenCalledTimes(1);
    expect(pushes).toEqual(['/settings/pets']);
  });

  it('omits surface pet controls when only the settings chooser is available', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: {
        executionRunsEnabled: false,
        voiceEnabled: false,
        memorySearchEnabled: false,
        petsCompanionEnabled: true,
      },
      petControls: {
        surface: 'none',
        wake: vi.fn(),
        tuck: vi.fn(),
        refreshCodexPets: vi.fn(),
      },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.some((command) => command.id === 'ui.pet.choose')).toBe(true);
    expect(cmds.some((command) => command.id === 'pet-wake')).toBe(false);
    expect(cmds.some((command) => command.id === 'pet-tuck')).toBe(false);
    expect(cmds.some((command) => command.id === 'pet-reset-position')).toBe(false);
    expect(cmds.some((command) => command.id === 'pet-refresh-codex')).toBe(false);
  });
});
