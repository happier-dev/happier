import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActionSpec,
  isVoiceSdkSafeActionSpec,
  listVoiceToolActionSpecs,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { resolveEnabledVoiceToolActionSpecsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

describe('bundled Conversation runtime host tool projection', () => {
  let previousSettings: ReturnType<typeof storage.getState>['settings'];

  beforeEach(() => {
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

  afterEach(() => {
    storage.setState((current) => ({ ...current, settings: previousSettings }));
  });

  it('projects current UI read and effect capabilities only from the local AppShell port and only with stable effect custody', () => {
    const withoutPort = createBundledConversationRuntimeHostLease();
    const withPort = createBundledConversationRuntimeHostLease({
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand: async () => ({ ok: true as const }),
        invokeAction: async () => ({ ok: true as const }),
      },
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
    // `session.message.send` is a canonical mutation with a non-port-bound
    // handler. Contextual commands intentionally require the injected AppShell
    // port and therefore cannot establish this generic custody invariant.
    const effectfulSpec = resolveEnabledVoiceToolActionSpecsFromState(storage.getState()).find(
      (spec) => spec.id === 'session.message.send' && !isVoiceSdkSafeActionSpec(spec),
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

  it('keeps direct provider callbacks read-only and rejects effectful Action definitions without a call identity', async () => {
    const readCurrentUiContext = vi.fn(() => ({
      navigation: { area: 'app', screen: 'home' },
      commands: [],
    }));
    const invokeAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        credential: { token: 'private-action-token' },
        providerId: 'private-action-provider',
        connectionId: 'private-action-connection',
        originalInput: { body: 'private action body' },
        error: { message: 'raw action error' },
      },
    }));
    const invokeCurrentUiCommand = vi.fn(async () => ({
      ok: true as const,
      result: {
        credential: { token: 'private-command-token' },
        providerId: 'private-command-provider',
        connectionId: 'private-command-connection',
        commandId: 'current-ui-command:private-selection',
        error: { message: 'raw command error' },
      },
    }));
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext: {
        readCurrentUiContext,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeAction,
        invokeCurrentUiCommand,
      },
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

      await expect(readCurrentUiContextTool.execute({})).resolves.toEqual({
        navigation: { area: 'app', screen: 'home' },
        commands: [],
      });
      await expect(invokeActionTool.execute({
        action: { pluginId: 'acme.triage', localId: 'comment' },
        input: { body: 'private action body' },
      })).rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
      await expect(invokeCurrentUiCommandTool.execute({
        commandId: 'current-ui-command:private-selection',
      })).rejects.toMatchObject({ code: 'voice_effect_call_custody_required' });
    } finally {
      lease.revoke();
    }

    expect(readCurrentUiContext).toHaveBeenCalledTimes(1);
    expect(invokeAction).not.toHaveBeenCalled();
    expect(invokeCurrentUiCommand).not.toHaveBeenCalled();
  });

  it('keeps a direct read bounded to its current host generation', async () => {
    const readCurrentUiContext = vi.fn(() => ({
      navigation: { area: 'app', screen: 'home' },
      commands: [],
    }));
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext: {
        readCurrentUiContext,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
      },
    });
    const toolName = String(
      getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '',
    ).trim();
    const tool = lease.host.getRealtimeClientToolDefinitions({
      effectCalls: 'stable_ids',
      exposure: 'voice_assistant',
    }).find((candidate) => candidate.name === toolName);

    if (!tool) throw new Error('Expected current UI read tool');

    await expect(tool.execute({})).resolves.toEqual({
      navigation: { area: 'app', screen: 'home' },
      commands: [],
    });
    lease.revoke();
    await expect(tool.execute({})).rejects.toThrow('voice_runtime_generation_revoked');
    expect(readCurrentUiContext).toHaveBeenCalledTimes(1);
  });

  it('rechecks Voice inventory privacy before executing a captured direct read', async () => {
    const previousSettings = storage.getState().settings;
    const lease = createBundledConversationRuntimeHostLease();
    const tool = lease.host.getRealtimeClientToolDefinitions({
      effectCalls: 'none',
      exposure: 'voice_assistant',
    }).find((candidate) => candidate.name === 'listMachines');
    if (!tool) throw new Error('Expected listMachines direct read');

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

      await expect(tool.execute({})).rejects.toThrow('voice_action_unavailable');
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
    }).find((candidate) => candidate.name === 'listMachines');
    if (!tool) throw new Error('Expected listMachines direct read');

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

      await expect(tool.execute({})).rejects.toThrow('voice_action_unavailable');
    } finally {
      lease.revoke();
      storage.setState((current) => ({ ...current, settings: previousSettings }) as never);
    }
  });
  it('narrows the canonical Action projection to the current-UI tools for a current-UI-only exposure', () => {
    const lease = createBundledConversationRuntimeHostLease({
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand: async () => ({ ok: true as const }),
        invokeAction: async () => ({ ok: true as const }),
      },
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
      expect(assistantNames).toContain('listMachines');
      expect(scopedNames).not.toContain('listMachines');
    } finally {
      lease.revoke();
    }
  });
});
