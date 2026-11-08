import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as React from 'react';

import {
  getActionSpec,
  isVoicePromptHotPathSpec,
  isVoiceSdkSafeActionSpec,
  listVoiceToolActionSpecs,
} from '@happier-dev/protocol/actions/actionSpecs';

import { storage } from '@/sync/domains/state/storage';
import { resolveEnabledVoiceToolActionSpecsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import { renderScreen } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextVoiceToolPort, type CurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useRouter } from 'expo-router';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const route = vi.hoisted(() => ({ pathname: '/settings/voice', segments: ['(app)', 'settings', 'voice'] }));
const nativeNavigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
  pathname: () => route.pathname, segments: () => route.segments, router: nativeNavigation,
}).module);
await loadSyncSingletonForTests();

async function mountCurrentUiPort(withCommand = false) {
  const account = await createVoiceSettingsAccountTestHarness(settingsParse(storage.getState().settings));
  const mountedPort: { current: CurrentUiContextVoiceToolPort | null } = { current: null };
  const enrichment = { commands: [] };
  function Publication() {
    const router = useRouter();
    const commands = React.useMemo(() => withCommand ? [{ key: 'open-voice-settings', title: 'Open Voice settings',
      invoke: () => router.push({ pathname: SETTINGS_ROUTES.voiceConversations }) }] : [], [router]);
    useCurrentUiContextLocalCommands(commands);
    usePublishCurrentUiContext(enrichment);
    mountedPort.current = useCurrentUiContextVoiceToolPort();
    return null;
  }
  const tree = React.createElement(InjectedAuthProvider, { credentials: account.credentials, children:
    React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, { children:
      React.createElement(CurrentUiContextProvider, { children: React.createElement(PluginSurfaceFocusEligibilityProvider,
        { active: true, currentUiContextActive: true, children: React.createElement(Publication) }) }) }) }) });
  let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
  onTestFinished(async () => { await screen?.unmount(); await account.dispose(); });
  screen = await renderScreen(tree);
  const port = mountedPort.current;
  if (!port) throw new Error('Actual mounted AppShell port unavailable');
  expect(port.readCurrentUiContext()).toMatchObject({ navigation: { area: 'settings', screen: 'settings/voice' } });
  return port;
}

describe('bundled Conversation runtime host tool projection', () => {
  let previousSettings: ReturnType<typeof storage.getState>['settings'];

  beforeEach(() => {
    nativeNavigation.push.mockClear();
    previousSettings = storage.getState().settings;
    storage.setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        experiments: true,
        featureToggles: {
          ...current.settings.featureToggles,
          voice: true,
        },
        voice: {
          ...current.settings.voice,
          privacy: {
            ...current.settings.voice.privacy,
            currentUiContextMode: 'on_demand',
            shareDeviceInventory: true,
          },
        },
      },
    }));
  });

  afterEach(async () => {
    await React.act(async () => {
      storage.setState((current) => ({ ...current, settings: previousSettings }));
    });
  });

  it.each([false, true])('finishes only its exact retiring machine snapshot after host replacement (replacement started: %s)', async (replacementStarted) => {
    const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    const old = createBundledConversationRuntimeHostLease();
    let replacement: ReturnType<typeof createBundledConversationRuntimeHostLease> | undefined;
    const sessionId = 'same-control-session';
    const adapterId = 'retiring-provider';
    try {
      old.host.machine.transitionToConnecting(sessionId, adapterId, 1);
      old.host.machine.transitionToConnected(sessionId, adapterId, 1);
      old.host.machine.transitionToEnding(sessionId, adapterId, 1);
      replacement = createBundledConversationRuntimeHostLease();
      if (replacementStarted) {
        replacement.host.machine.transitionToConnecting(sessionId, adapterId, 1);
        replacement.host.machine.transitionToConnected(sessionId, adapterId, 1);
      }
      const beforeCleanup = machine.getSnapshot();
      old.host.machine.transitionToDisconnected(sessionId, adapterId, null, 1);
      if (replacementStarted) expect(machine.getSnapshot()).toBe(beforeCleanup);
      else expect(machine.getSnapshot().state).toBe('disconnected');

      // A replacement can reuse both ids and its controller's first attempt
      // number. Those values must not authorize the old host's late cleanup.
      replacement.host.machine.transitionToConnecting(sessionId, adapterId, 1);
      replacement.host.machine.transitionToConnected(sessionId, adapterId, 1);
      const live = machine.getSnapshot();
      old.host.machine.transitionToDisconnected(sessionId, adapterId, null, 1);
      expect(machine.getSnapshot()).toBe(live);
    } finally {
      old.revoke();
      replacement?.revoke();
      machine.reset();
    }
  });

  it('projects current UI read and effect capabilities only from the local AppShell port and only with stable effect custody', async () => {
    const withoutPort = createBundledConversationRuntimeHostLease();
    const withPort = createBundledConversationRuntimeHostLease({
      currentUiContext: await mountCurrentUiPort(),
    });
    try {
      const toolNames = (
        lease: typeof withPort,
        effectCalls: 'none' | 'stable_ids',
      ) => lease.host.getRealtimeClientToolDefinitions({ effectCalls, exposure: 'voice_assistant' })
        .map((tool) => tool.name);

      expect(toolNames(withoutPort, 'none')).not.toContain('readCurrentUiContext');
      expect(toolNames(withPort, 'none')).toContain('readCurrentUiContext');
      expect(toolNames(withPort, 'stable_ids')).toContain('invokeCurrentUiCommand');
      expect(toolNames(withPort, 'stable_ids')).toContain('invokeAction');
      expect(toolNames(withPort, 'none')).not.toContain('invokeCurrentUiCommand');
      expect(toolNames(withPort, 'none')).not.toContain('invokeAction');
    } finally {
      withoutPort.revoke();
      withPort.revoke();
    }
  });

  it('keeps effectful canonical ActionSpecs closed until the provider declares stable call/result custody', () => {
    // `session.user_action.answer` is a canonical mutation with a non-port-bound
    // handler. Contextual commands intentionally require the injected AppShell
    // port and therefore cannot establish this generic custody invariant.
    const effectfulSpec = resolveEnabledVoiceToolActionSpecsFromState(storage.getState()).find(
      (spec) => spec.id === 'session.user_action.answer' && !isVoiceSdkSafeActionSpec(spec),
    );
    expect(effectfulSpec).toBeDefined();
    const effectfulToolName = String(effectfulSpec?.bindings?.voiceClientToolName ?? '').trim();
    const lease = createBundledConversationRuntimeHostLease();
    try {
      const toolNames = (effectCalls: 'none' | 'stable_ids') => lease.host
        .getRealtimeClientToolDefinitions({ effectCalls, exposure: 'voice_assistant' })
        .map((tool) => tool.name);

      const withoutStableIds = toolNames('none');
      const withStableIds = toolNames('stable_ids');

      expect(withoutStableIds).not.toContain(effectfulToolName);
      expect(withStableIds).toContain(effectfulToolName);
    } finally {
      lease.revoke();
    }
  });

  it('projects hot-path tools and discovery while retaining non-hot-path Actions through generic execution', async () => {
    const lease = createBundledConversationRuntimeHostLease({ currentUiContext: await mountCurrentUiPort() });
    try {
      const enabled = resolveEnabledVoiceToolActionSpecsFromState(storage.getState());
      const nonHotPath = enabled.find((spec) => !isVoicePromptHotPathSpec(spec)
        && spec.id !== 'action.spec.search' && spec.id !== 'action.spec.get');
      expect(nonHotPath).toBeDefined();
      const names = lease.host.getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure: 'voice_assistant' })
        .map((tool) => tool.name);
      const listTool = lease.host.getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure: 'voice_assistant' })
        .find((tool) => tool.name === 'listSessions');
      expect(Object.keys(listTool?.parameters.properties ?? {}).sort()).toEqual(['cursor', 'limit']);
      expect(names).toContain('action_execute');
      expect(names).toEqual(expect.arrayContaining(['searchActionSpecs', 'getActionSpec']));
      expect(names).not.toContain(nonHotPath?.bindings?.voiceClientToolName);
      expect(names.filter((name) => name !== 'action_execute').sort()).toEqual(enabled.filter((spec) =>
        isVoicePromptHotPathSpec(spec) || spec.id === 'action.spec.search' || spec.id === 'action.spec.get',
      ).map((spec) => spec.bindings?.voiceClientToolName).sort());
    } finally {
      lease.revoke();
    }
  });

  it('keeps generic direct SDK callbacks read-only and rechecks target availability', async () => {
    const lease = createBundledConversationRuntimeHostLease({ currentUiContext: await mountCurrentUiPort() });
    try {
      const generic = lease.host.getRealtimeClientToolDefinitions({ effectCalls: 'none', exposure: 'voice_assistant' })
        .find((tool) => tool.name === 'action_execute');
      expect(generic).toBeDefined();
      if (!generic) throw new Error('Expected generic Voice tool');
      await expect(generic.execute({ actionId: 'ui.current_context.read', input: {} }))
        .resolves.toMatchObject({ ok: true, result: { navigation: { area: 'settings', screen: 'settings/voice' } } });
      await expect(generic.execute({ actionId: 'session.message.send', input: { message: 'do not send' } }))
        .rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
      storage.setState((current) => ({ ...current, settings: { ...current.settings, voice: {
        ...current.settings.voice, privacy: { ...current.settings.voice.privacy, currentUiContextMode: 'off' },
      } } }));
      await expect(generic.execute({ actionId: 'ui.current_context.read', input: {} }))
        .rejects.toThrow('voice_action_unavailable');
    } finally {
      lease.revoke();
    }
  });

  it('keeps direct provider callbacks read-only and rejects effectful Action definitions without a call identity', async () => {
    const currentUiContext = await mountCurrentUiPort(true);
    const currentUiBefore = currentUiContext.readCurrentUiContext();
    const commandId = currentUiBefore?.commands.find(command => command.title === 'Open Voice settings')?.id;
    if (!commandId) throw new Error('Actual mounted command descriptor unavailable');
    expect(currentUiContext.resolveCurrentUiCommand(commandId)?.retirementSignal.aborted).toBe(false);
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext,
    });
    const invokeActionToolName = String(
      getActionSpec('action.invoke').bindings?.voiceClientToolName ?? '',
    ).trim();
    const invokeCurrentUiCommandToolName = String(
      getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? '',
    ).trim();
    const readCurrentUiContextToolName = String(
      getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '',
    ).trim();
    try {
      const tools = lease.host.getRealtimeClientToolDefinitions({
        effectCalls: 'stable_ids',
        exposure: 'voice_assistant',
      });
      const invokeActionTool = tools.find((tool) => tool.name === invokeActionToolName);
      const invokeCurrentUiCommandTool = tools.find((tool) => tool.name === invokeCurrentUiCommandToolName);
      const readCurrentUiContextTool = tools.find((tool) => tool.name === readCurrentUiContextToolName);
      if (!invokeActionTool || !invokeCurrentUiCommandTool || !readCurrentUiContextTool) {
        throw new Error('Expected stable-id Action, current UI command, and read tools');
      }

      await expect(readCurrentUiContextTool.execute({})).resolves.toEqual(currentUiBefore);
      await expect(invokeActionTool.execute({
        action: { pluginId: 'acme.triage', localId: 'comment' },
        input: { body: 'private action body' },
      })).rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
      await expect(invokeCurrentUiCommandTool.execute({
        commandId,
      })).rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
    } finally {
      lease.revoke();
    }

    expect(currentUiContext.readCurrentUiContext()).toEqual(currentUiBefore);
    expect(nativeNavigation.push).not.toHaveBeenCalled();
  });

  it('keeps a direct read bounded to its current host generation', async () => {
    const currentUiContext = await mountCurrentUiPort();
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext,
    });
    const toolName = String(
      getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '',
    ).trim();
    const tool = lease.host.getRealtimeClientToolDefinitions({
      effectCalls: 'stable_ids',
      exposure: 'voice_assistant',
    }).find((candidate) => candidate.name === toolName);

    if (!tool) throw new Error('Expected current UI read tool');

    await expect(tool.execute({})).resolves.toEqual(currentUiContext.readCurrentUiContext());
    lease.revoke();
    await expect(tool.execute({})).rejects.toThrow('voice_runtime_generation_revoked');
  });

  it('rechecks Voice inventory privacy before executing a captured direct read', async () => {
    const previousSettings = storage.getState().settings;
    const lease = createBundledConversationRuntimeHostLease();
    const tool = lease.host.getRealtimeClientToolDefinitions({
      effectCalls: 'none',
      exposure: 'voice_assistant',
    }).find((candidate) => candidate.name === 'action_execute');
    if (!tool) throw new Error('Expected generic read tool');

    try {
      storage.setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          voice: {
            ...current.settings.voice,
            privacy: {
              ...current.settings.voice.privacy,
              shareDeviceInventory: false,
            },
          },
        },
      }) as never);

      await expect(tool.execute({ actionId: 'machines.list', input: {} })).rejects.toThrow('voice_action_unavailable');
    } finally {
      lease.revoke();
      storage.setState((current) => ({ ...current, settings: previousSettings }) as never);
    }
  });

  it('rechecks Action surface enablement before executing a captured direct read', async () => {
    const previousSettings = storage.getState().settings;
    const spec = listVoiceToolActionSpecs().find(
      (candidate) => String(candidate.bindings?.voiceClientToolName ?? '').trim() === 'listMachines',
    );
    if (!spec) throw new Error('Expected listMachines ActionSpec');
    const lease = createBundledConversationRuntimeHostLease();
    const tool = lease.host.getRealtimeClientToolDefinitions({
      effectCalls: 'none',
      exposure: 'voice_assistant',
    }).find((candidate) => candidate.name === 'action_execute');
    if (!tool) throw new Error('Expected generic read tool');

    try {
      storage.setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          actionsSettingsV1: {
            v: 1,
            actions: {
              ...(current.settings.actionsSettingsV1?.actions ?? {}),
              [spec.id]: { disabledSurfaces: ['voice'] },
            },
          },
        },
      }) as never);

      await expect(tool.execute({ actionId: 'machines.list', input: {} })).rejects.toThrow('voice_action_unavailable');
    } finally {
      lease.revoke();
      storage.setState((current) => ({ ...current, settings: previousSettings }) as never);
    }
  });
  it('narrows the canonical Action projection to the current-UI tools for a current-UI-only exposure', async () => {
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext: await mountCurrentUiPort(),
    });
    try {
      const currentUiToolNames = new Set(
        (['ui.current_context.read', 'ui.current_context.command.invoke'] as const)
          .map((actionId) => String(getActionSpec(actionId).bindings?.voiceClientToolName ?? '').trim()),
      );
      const names = (exposure: 'voice_assistant' | 'current_ui_only') => lease.host
        .getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure })
        .map((tool) => tool.name);

      const assistantNames = names('voice_assistant');
      const scopedNames = names('current_ui_only');

      // The attached Agent runtime owns cross-session/device discovery, so the
      // realtime surface must publish nothing beyond the current-UI tools.
      expect(scopedNames.length).toBeGreaterThan(0);
      expect(scopedNames.every((name) => currentUiToolNames.has(name))).toBe(true);
      expect(assistantNames).toEqual(expect.arrayContaining(scopedNames));
      // A cross-session discovery tool proves the unscoped surface is broader,
      // so the narrowing above is real rather than an empty inventory.
      expect(assistantNames).toContain('searchActionSpecs');
      expect(assistantNames).toContain('action_execute');
      expect(scopedNames).not.toContain('action_execute');
      expect(scopedNames).not.toContain('listMachines');
    } finally {
      lease.revoke();
    }
  });
});
