import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  PluginProjectedActionV2Schema,
  type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import { VoiceConversationActionResultSchema } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

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
    getState: () => ({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, ...mockedState }),
  },
});
});

/** The two built-in destinations the catalog marks for empty Search, as it projects them. */
const SUGGESTED_BUILTIN_DESTINATIONS = [
  {
    kind: 'builtin', id: 'sessions', title: 'Sessions', icon: 'chats-circle', order: 0,
    placement: { kind: 'rail', region: 'app' }, column: 'sessions', activation: 'navigate',
    routePath: '/', suggested: true, availability: 'available',
  },
  {
    kind: 'builtin', id: 'settings', title: 'Settings', icon: 'gear', order: 1,
    placement: { kind: 'rail', region: 'account' }, column: 'settings', activation: 'navigate',
    routePath: '/settings', shortcut: 'settings.open', suggested: true, availability: 'available',
  },
] as const satisfies readonly CompactAppDestination[];

function commandTitles(cmds: readonly Command[]): string[] {
  return cmds.map((c) => c.title);
}

it('does not advertise unavailable host destinations as invokable UI commands while retaining plugin tombstones', () => {
    const destinations = [
        ...SUGGESTED_BUILTIN_DESTINATIONS,
        { ...SUGGESTED_BUILTIN_DESTINATIONS[0], id: 'unavailableHostDestination', availability: 'unavailable' as const },
        {
            kind: 'plugin' as const, container: 'appPage' as const, id: 'plugin:unavailable',
            destination: { pluginId: 'acme.example', localId: 'unavailable' },
            title: 'Unavailable destination', icon: 'chats-circle' as const, order: 2,
            placement: { kind: 'rail' as const, region: 'plugins' as const }, activation: 'navigate' as const,
            routePath: '/plugins/acme.example/unavailable', availability: 'unavailable' as const,
            unavailableReason: 'notInstalled',
        },
        {
            kind: 'plugin' as const, container: 'rightSidebarTab' as const, id: 'rightSidebarTab:unavailable',
            destination: { pluginId: 'acme.example', localId: 'unavailablePanel' },
            title: 'Unavailable panel', icon: 'chats-circle' as const, order: 3,
            placement: { kind: 'rail' as const, region: 'plugins' as const }, activation: 'rightSidebarTab' as const,
            routePath: '/settings/plugins/panels', availability: 'unavailable' as const,
            unavailableReason: 'notInstalled',
        },
    ];
    const commands = buildCommandPaletteCommands({
        sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
        compactAppDestinations: destinations, onActivateCompactAppDestination: () => {},
        actions: { execute: async () => ({ ok: true, result: {} }) }, alert: () => {},
    });
    expect(commands.map((command) => command.id)).toContain('app-destination:sessions');
    expect(commands.map((command) => command.id)).not.toContain('app-destination:unavailableHostDestination');
    expect(commands.map((command) => command.id)).not.toContain('app-destination:rightSidebarTab:unavailable');
    expect(commands.map((command) => command.id)).toContain('app-destination:plugin:unavailable');
});

it('keeps Ask Happier manual commands and captures the selected release without starting a session', async () => {
    const openAskHappier = vi.fn();
    const openNewSession = vi.fn();
    const release = { id: 'release-a', versionLabel: '0.3.2', date: '2026-10-06', markdown: 'Selected release notes' };
    const commands = buildCommandPaletteCommands({
        sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push: () => {}, openNewSession, navigateToSession: () => {}, openAskHappier },
        askHappierRelease: release,
        actions: { execute: async () => ({ ok: true, result: {} }) }, alert: () => {},
    });
    expect(openAskHappier).not.toHaveBeenCalled();
    expect(openNewSession).not.toHaveBeenCalled();
    const manual = commands.find((command) => command.id === 'askHappier');
    const aboutUpdate = commands.find((command) => command.id === 'askHappier.aboutUpdate');
    expect(manual).toBeDefined();
    expect(aboutUpdate).toBeDefined();
    // A refreshed changelog must not silently replace the release selected by this command.
    release.markdown = 'Later refresh';
    await aboutUpdate!.action();
    expect(openAskHappier).toHaveBeenLastCalledWith({
        kind: 'release', release: { id: 'release-a', versionLabel: '0.3.2', date: '2026-10-06', markdown: 'Selected release notes' },
    });
    await manual!.action();
    expect(openAskHappier).toHaveBeenLastCalledWith();
    expect(openNewSession).not.toHaveBeenCalled();
});

it('exposes the text-in-files entry through the command catalog used by UI Actions', async () => {
    const openTextInFiles = vi.fn();
    const commands = buildCommandPaletteCommands({
        sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {}, openTextInFiles },
        actions: { execute: async () => ({ ok: true, result: {} }) }, alert: () => {},
    });
    const command = commands.find((entry) => entry.id === 'search.textInFiles');
    expect(command).toBeDefined();
    await command!.action();
    expect(openTextInFiles).toHaveBeenCalled();
});

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
    occurrenceId: action.occurrenceId,
    title: action.title,
    ...(action.description ? { description: action.description } : {}),
    ...(action.icon ? { icon: action.icon } : {}),
    scopes: action.scopes,
    surfaces: action.surfaces,
    execution: { target: 'daemon' },
    ...(action.placementBindings.length > 0 ? { placementBindings: action.placementBindings } : {}),
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
    occurrenceId: input.occurrenceId ?? 'commands-occurrence-a',
    title: input.title ?? input.id,
    description: input.description ?? null,
    icon: input.icon ?? null,
    scopes: input.scopes ?? ['session'],
    surfaces: input.surfaces ?? ['ui'],
    placementBindings: input.placementBindings ?? ['commandPalette'],
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
    features: { executionRunsEnabled: false, voiceEnabled: false },
    nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
    actions: { execute: async () => ({ ok: true, result: {} }) },
    alert: async () => {},
    pluginActionPresentation: {
      controller: input.controller,
      scope: input.scope,
    },
  });
}

describe('buildCommandPaletteCommands', () => {
  it('offers gated workflow creation commands through their canonical authoring openers', async () => {
    const openNewWorkflow = vi.fn();
    const openWorkflowAgentAuthoring = vi.fn();
    const input: Parameters<typeof buildCommandPaletteCommands>[0] = {
      sessionsById: {}, isDev: false, activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, workflowsEnabled: true },
      nav: { push: vi.fn(), openNewSession: vi.fn(), navigateToSession: vi.fn(), openNewWorkflow, openWorkflowAgentAuthoring },
      actions: { execute: vi.fn() }, alert: vi.fn(),
    };
    const commands = buildCommandPaletteCommands(input);
    const create = commands.find((command) => command.id === 'workflow.new');
    const agent = commands.find((command) => command.id === 'workflow.createWithAgent');
    expect(create).toBeDefined();
    expect(agent).toBeDefined();
    await create?.action();
    await agent?.action();
    expect(openNewWorkflow).toHaveBeenCalledOnce();
    expect(openWorkflowAgentAuthoring).toHaveBeenCalledOnce();
    expect(buildCommandPaletteCommands({ ...input, features: { ...input.features, workflowsEnabled: false } })
      .some((command) => command.id.startsWith('workflow.'))).toBe(false);
  });
  it('opens session and pending walkthroughs in the active Session Home without starting analysis', async () => {
    const push = vi.fn();
    const execute = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const commands = buildCommandPaletteCommands({
      sessionsById: {}, isDev: false, activeSessionId: 'session-walk', activeSessionServerId: 'server-walk',
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: { push, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute }, alert: async () => {},
    });
    const session = commands.find((command) => command.id === 'walkthrough:session');
    const pending = commands.find((command) => command.id === 'walkthrough:workingTree');
    expect(session).toBeDefined();
    expect(pending).toBeDefined();
    await session?.action();
    await pending?.action();
    expect(push.mock.calls.map(([href]) => new URL(href, 'https://happier.test').searchParams.get('comparison'))).toEqual(['session', 'workingTree']);
    for (const [href] of push.mock.calls) {
      const url = new URL(href, 'https://happier.test');
      expect(url.pathname).toContain('session-walk');
      expect(url.searchParams.get('serverId')).toBe('server-walk');
      expect(url.searchParams.get('details')).toBe('scmReview');
      expect(url.searchParams.get('view')).toBe('walkthrough');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('offers phone pairing without navigating away from the current page', async () => {
    const openHomePairingModal = vi.fn();
    const push = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const commands = buildCommandPaletteCommands({
      sessionsById: {}, isDev: false, activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push, openNewSession: () => {}, navigateToSession: () => {}, openHomePairingModal },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });
    const pairing = commands.find((command) => command.id === 'add-phone');
    expect(pairing).toBeDefined();
    await pairing?.action();
    expect(openHomePairingModal).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('marks a small intentional launch set for empty Search', () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const commands = buildCommandPaletteCommands({
      sessionsById: { 'session-1': { id: 'session-1', serverId: 'server-a', metadata: {} } },
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
      compactAppDestinations: SUGGESTED_BUILTIN_DESTINATIONS,
      onActivateCompactAppDestination: () => {},
    });

    expect(commands.filter((command) => command.emptyQuerySuggested).map((command) => command.id))
      .toEqual(['new-session', 'app-destination:sessions', 'app-destination:settings']);
  });

  it('routes sign-out through the confirmed account-settings flow', async () => {
    const push = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const commands = buildCommandPaletteCommands({
      sessionsById: { 'session-1': { id: 'session-1', serverId: 'server-a', metadata: {} } },
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    await commands.find((command) => command.id === 'sign-out')?.action();

    expect(push).toHaveBeenCalledWith('/settings/account');
  });

  it('delegates the new-session command to the caller-owned ordinary-entry callback', async () => {
    const openNewSession = vi.fn();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const commands = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: {
        push: vi.fn(),
        openNewSession,
        navigateToSession: () => {},
      },
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
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(commands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-voice-history-hidden' }),
    ]));
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-ordinary-recent', kind: 'recentSession' }),
    ]));
  });

  it('opens a recent session on the Home its row already names', () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };
    const navigateToSession = vi.fn();

    const commands = buildCommandPaletteCommands({
      sessionsById: {
        'cross-home-recent': {
          id: 'cross-home-recent',
          serverId: 'home-b',
          updatedAt: 100,
          metadata: { name: 'Recent on another Home' },
        },
      },
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    } as never);

    commands.find((command) => command.id === 'session-cross-home-recent')?.action();

    expect(navigateToSession).toHaveBeenCalledWith('cross-home-recent', { serverId: 'home-b' });
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
        placement: { kind: 'column', column: 'sessions' },
        activation: 'navigate',
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
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
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
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
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
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: {
        push: (path: string) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
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
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
      compactAppDestinations: [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:hidden',
        destination: { pluginId: 'acme.notes', localId: 'hidden' },
        title: 'Hidden notes',
        icon: 'note',
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
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
    mockedState = {
      profileScope: { serverId: 'home-b', accountId: 'account-b' },
      createSessionActionDraft: createSessionActionDraftSpy,
      settings: buildSettingsWithExecutionRunsEnabled(),
    };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': { id: 'session-1', serverId: 'home-b', metadata: { flavor: 'claude' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      activeSessionServerId: 'home-b',
      features: { executionRunsEnabled: true, voiceEnabled: true },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
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

    const openRuns = cmds.find((c) => c.title === 'Open session runs');
    expect(openRuns).toBeTruthy();
    await openRuns!.action();
    expect(pushes).toContain('/session/session-1/runs?serverId=home-b');

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();
    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalled();
  });

  it('offers Voice controls through Actions and captures the current attempt when invoked', async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    mockedState = { settings: {} };
    let attemptId = 'old-attempt';
    const commands = buildCommandPaletteCommands({
      sessionsById: {}, isDev: false, activeSessionId: 'navigated-session', activeSessionServerId: 'home-b',
      features: { executionRunsEnabled: false, voiceEnabled: true },
      nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async (actionId, input) => {
        calls.push({ actionId, input });
        return { ok: true, result: VoiceConversationActionResultSchema.parse({ status: 'completed', voice: {
          attemptId, adapterId: 'local_conversation', sessionId: 'voice-control', status: 'connected', mode: 'listening',
          target: { kind: 'session', sessionAddress: { serverId: 'home-a', sessionId: 'captured-session' } },
          conversationSessionAddress: { serverId: 'home-a', sessionId: 'voice-control' },
          targetSessionAddress: { serverId: 'home-a', sessionId: 'captured-session' },
          canStart: false, canStop: true, canMute: true, canCommitInput: true, canHoldToTalk: true,
          muted: true, canDismissFailedAttempt: false, canDismissEnded: false, recoveryAction: null, availability: 'ready',
          inUseVoice: null,
        } }) };
      } }, alert: () => {},
    });
    const end = commands.find((command) => command.actionSpecId === 'ui.voice_global.end');
    expect(end).toBeDefined();
    // The palette can stay open while navigation and the actual Voice attempt change.
    attemptId = 'replacement-attempt';
    await end?.action();
    expect(calls).toEqual([
      { actionId: 'ui.voice_global.get', input: {} },
      { actionId: 'ui.voice_global.end', input: { expectedAttempt: 'replacement-attempt' } },
    ]);
    expect(commands.some((command) => command.actionSpecId === 'ui.voice_global.start')).toBe(true);
    expect(commands.some((command) => command.actionSpecId === 'ui.voice_global.set_muted')).toBe(true);
    expect(commands.some((command) => command.actionSpecId === 'ui.voice_global.brief.request')).toBe(true);
  });

  it('discovers Voice executable settings at their declared anchored controls', async () => {
    const pushes: string[] = [];
    mockedState = { settings: {} };
    const commands = buildCommandPaletteCommands({
      sessionsById: {}, isDev: false, activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: true },
      nav: { push: path => pushes.push(path), openNewSession: () => {}, navigateToSession: () => {} },
      actions: { execute: async () => ({ ok: true }) }, alert: () => {},
    });
    const install = commands.find(command => command.id === 'setting-operation:voiceAdvanced.installSpeechModel');
    expect(install).toBeDefined();
    await install?.action();
    expect(pushes[0]).toContain('voiceAdvanced.installSpeechModel');
  });

  it('shows an alert when a session-scoped ActionSpec command is used without an active session', async () => {
    const alerts: Array<{ title: string; message: string }> = [];
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
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
        'session-1': { id: 'session-1', serverId: 'server-a', metadata: { agent: 'coderabbit', name: 'x' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();

    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalledTimes(1);

    const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
    expect(call.slice(0, 2)).toEqual([
      { serverId: 'server-a', accountId: 'account-a' },
      { serverId: 'server-a', sessionId: 'session-1' },
    ]);
    const created = call[2] as any;
    expect(created?.actionId).toBe('review.start');
    expect(created?.input?.engineIds).toBeUndefined();
    expect(created?.input?.engines).toBeUndefined();
  });

  it('uses execution-run permission defaults for execution-run drafts', async () => {
    createSessionActionDraftSpy.mockClear();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: buildSettingsWithExecutionRunsEnabled() };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': { id: 'session-1', serverId: 'server-a', metadata: { agent: 'codex', name: 'x' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const expectations: Array<Readonly<{ title: string; actionId: string; permissionMode: string }>> = [
      { title: 'Start review run', actionId: 'review.start', permissionMode: 'read_only' },
      { title: 'Start plan run', actionId: 'subagents.plan.start', permissionMode: 'read_only' },
      { title: 'Start delegation run', actionId: 'subagents.delegate.start', permissionMode: 'workspace_write' },
    ];

    for (const expected of expectations) {
      createSessionActionDraftSpy.mockClear();
      const command = cmds.find((entry) => entry.title === expected.title);
      expect(command).toBeTruthy();
      await command!.action();

      expect(createSessionActionDraftSpy).toHaveBeenCalledTimes(1);
      const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
      const created = call[2] as any;
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
          serverId: 'server-a',
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
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const startPlan = cmds.find((c) => c.title === 'Start plan run');
    expect(startPlan).toBeTruthy();

    await startPlan!.action();
    const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
    const created = call[2] as any;
    expect(created?.actionId).toBe('subagents.plan.start');
    expect(created?.input?.backendTargetKeys).toEqual(['backend:review-bot:configured:review-bot']);
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
      features: { executionRunsEnabled: true, voiceEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(commandTitles(cmds)).not.toEqual(expect.arrayContaining(['Start review run']));
  });

  it('does not include the retired standalone memory-search command', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.some((command) => command.id === 'memory-search')).toBe(false);
  });

  it('uses effective registry shortcut labels and omits stale display-only labels', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      shortcutLabels: {
        'session.new': 'Cmd+P',
      },
      nav: {
        push: () => {},
        openNewSession: () => {},
        navigateToSession: () => {},
      },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
      compactAppDestinations: SUGGESTED_BUILTIN_DESTINATIONS,
      onActivateCompactAppDestination: () => {},
    });

    expect(cmds.find((command) => command.id === 'new-session')?.shortcut).toBe('Cmd+P');
    // Settings' own shortcut is disabled in this registry, so its destination shows none.
    expect(cmds.find((command) => command.id === 'app-destination:settings')?.shortcut).toBeUndefined();
    expect(cmds.some((command) => command.shortcut === '⌘N' || command.shortcut === '⌘,')).toBe(false);
  });

  it('navigates to the terminal QR scanner from the connect terminal command', async () => {
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        openNewSession: () => {},
        navigateToSession: () => {},
      },
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
