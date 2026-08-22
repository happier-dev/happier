import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

const executeAction = vi.fn();

const state: any = {
  sessions: {
    s1: {
      active: true,
      agentState: {
        requests: {
          req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
          req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
        },
      },
    },
  },
};

installRealtimeCommonModuleMocks({
  storage: () =>
    createStorageModuleStub({
      storage: {
        getState: () => state,
      },
    }),
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({
    execute: (...args: any[]) => executeAction(...args),
  }),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: vi.fn(),
  },
}));

describe('realtimeClientTools action projection', () => {
  beforeEach(() => {
    executeAction.mockReset();
    executeAction.mockResolvedValue({ ok: true, result: { ok: true } });
    state.sessions.s1.agentState.requests = {
      req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
      req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
    };
    state.sessions.s1.active = true;
    state.settings = {
      voice: {
        privacy: { currentUiContextMode: 'on_demand' },
      },
    };

    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
  });

  it('does not expose speech-driven permission approval as a provider tool', async () => {
    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    const realtimeClientTools = createRealtimeClientTools();

    expect(realtimeClientTools).not.toHaveProperty('processPermissionRequest');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('routes structured user-action answers through the shared voice handlers', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
      req_permission: { id: 'req_permission', tool: 'Bash', kind: 'permission' },
    };
    state.sessions.s1.active = true;

    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    const realtimeClientTools = createRealtimeClientTools();

    const result = await (realtimeClientTools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(executeAction).toHaveBeenCalledWith(
      'session.user_action.answer',
      expect.objectContaining({
        sessionId: 's1',
        requestId: 'req_question',
        answers: [{ question: 'Continue?', values: ['Yes'] }],
      }),
      expect.objectContaining({ surface: 'voice' }),
    );
  });

  it.each(['on_demand', 'automatic'] as const)(
    'projects current UI reads and effectful opaque commands in %s mode without exposing semantic payloads',
    async (currentUiContextMode) => {
      state.settings.voice.privacy.currentUiContextMode = currentUiContextMode;
      const { createRealtimeClientTools } = await import('./realtimeClientTools');
      const invokeCurrentUiCommand = vi.fn(async () => ({
        ok: true as const,
        result: { kind: 'navigated' },
      }));
      const invokeAction = vi.fn(async () => ({
        ok: true as const,
        result: { status: 'refreshed' },
      }));
      const port = {
        readCurrentUiContext: () => ({
          navigation: { area: 'plugin', screen: 'triage-issues', title: 'Issues' },
          commands: [{ id: 'current-ui-command:1', title: 'Open issue' }],
        }),
        resolveCurrentUiCommand: () => ({
          id: 'current-ui-command:1',
          command: {
            kind: 'openSurface' as const,
            destination: { pluginId: 'triage', localId: 'issues' },
            input: { privateQuery: 'must-not-reach-voice-read' },
          },
          retirementSignal: new AbortController().signal,
        }),
        subscribe: () => () => {},
        invokeCurrentUiCommand,
        invokeAction,
      } satisfies VoiceCurrentUiToolPort;

      const tools = createRealtimeClientTools({ currentUiContext: port });
      expect(tools).toHaveProperty('readCurrentUiContext');
      expect(tools).toHaveProperty('invokeCurrentUiCommand');
      expect(tools).toHaveProperty('invokeAction');

      const result = await (tools as any).readCurrentUiContext({});
      expect(JSON.parse(result)).toEqual(port.readCurrentUiContext());
      expect(result).not.toContain('privateQuery');

      const commandResult = await (tools as any).invokeCurrentUiCommand({
        commandId: 'current-ui-command:1',
      });
      expect(JSON.parse(commandResult)).toEqual({ ok: true, result: { kind: 'navigated' } });
      expect(commandResult).not.toContain('current-ui-command:1');
      expect(commandResult).not.toContain('privateQuery');
      expect(invokeCurrentUiCommand).toHaveBeenCalledWith({
        commandId: 'current-ui-command:1',
      });

      const actionResult = await (tools as any).invokeAction({
        action: { pluginId: 'acme.triage', localId: 'refresh' },
        input: { source: 'voice' },
      });
      expect(JSON.parse(actionResult)).toEqual({ ok: true, result: { status: 'refreshed' } });
      expect(invokeAction).toHaveBeenCalledWith({
        action: { pluginId: 'acme.triage', localId: 'refresh' },
        input: { source: 'voice' },
      });
    },
  );

  it('omits current UI tools when the provider port is unavailable or privacy is off', async () => {
    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    expect(createRealtimeClientTools()).not.toHaveProperty('readCurrentUiContext');
    expect(createRealtimeClientTools()).not.toHaveProperty('invokeCurrentUiCommand');

    state.settings.voice.privacy.currentUiContextMode = 'off';
    const invokeAction = vi.fn(async () => ({ ok: true as const, result: { status: 'done' } }));
    const tools = createRealtimeClientTools({
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeAction,
      },
    });
    expect(tools).not.toHaveProperty('readCurrentUiContext');
    expect(tools).not.toHaveProperty('invokeCurrentUiCommand');
    expect(tools).toHaveProperty('invokeAction');
  });

  it('projects stale/failing effect settlements and cancellation as bounded Voice results', async () => {
    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    const invokeCurrentUiCommand = vi.fn(async () => ({
      ok: false as const,
      code: 'stale_surface' as const,
    }));
    const invokeAction = vi.fn(async () => ({
      ok: false as const,
      code: 'denied' as const,
    }));
    const tools = createRealtimeClientTools({
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand,
        invokeAction,
      },
    });

    const stale = await (tools as any).invokeCurrentUiCommand({ commandId: 'current-ui-command:retired' });
    expect(JSON.parse(stale)).toEqual({
      ok: false,
      errorCode: 'stale_surface',
      errorMessage: 'stale_surface',
    });
    expect(stale).not.toContain('current-ui-command:retired');

    const denied = await (tools as any).invokeAction({
      action: { pluginId: 'acme.triage', localId: 'refresh' },
      input: { private: 'must-not-be-echoed' },
    });
    expect(JSON.parse(denied)).toEqual({
      ok: false,
      errorCode: 'denied',
      errorMessage: 'denied',
    });
    expect(denied).not.toContain('must-not-be-echoed');

    const cancelled = new AbortController();
    cancelled.abort();
    await expect((tools as any).invokeCurrentUiCommand(
      { commandId: 'current-ui-command:cancelled' },
      { signal: cancelled.signal },
    )).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'tool_cancelled',
      errorMessage: 'tool_cancelled',
    }));
    expect(invokeCurrentUiCommand).toHaveBeenCalledTimes(1);
  });

  it('projects a read-only-only tool map for provider SDKs without observable mutation delivery', async () => {
    const { createRealtimeReadOnlyClientTools } = await import('./realtimeClientTools');
    const { getActionSpec, listVoiceToolActionSpecs } = await import('@happier-dev/protocol');
    const realtimeReadOnlyClientTools = createRealtimeReadOnlyClientTools();

    expect(Object.keys(realtimeReadOnlyClientTools).length).toBeGreaterThan(0);
    for (const spec of listVoiceToolActionSpecs()) {
      const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
      if (!toolName) continue;
      const effect = getActionSpec(spec.id).sideEffectClass;
      expect(Object.hasOwn(realtimeReadOnlyClientTools, toolName)).toBe(
        toolName !== 'readCurrentUiContext' && (effect === 'none' || effect === 'read'),
      );
    }
  });
});
