import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
installDisconnectedServerSocketBoundary((socket) => {
  socket.connected = true;
  vi.spyOn(socket, 'emit').mockReturnValue(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
    outgoing.push(payload);
    return { ok: true, result: undefined };
  });
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

type StoreState = ReturnType<ReturnType<typeof import('@/sync/domains/state/storage').getStorage>['getState']>;
let initialState: StoreState;
let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let authScreen: RenderScreenResult;

async function setCurrentUiPrivacy(currentUiContextMode: 'off' | 'on_demand' | 'automatic'): Promise<void> {
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const { getStorage } = await import('@/sync/domains/state/storage');
  const state = getStorage().getState();
  getStorage().setState({ settings: settingsParse({
    ...state.settings,
    voiceSettingsV1: {
      ...state.settings.voiceSettingsV1,
      privacy: { ...state.settings.voiceSettingsV1.privacy, currentUiContextMode },
    },
  }) });
}

describe('realtimeClientTools action projection', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await loadSyncSingletonForTests();
    const { getStorage } = await import('@/sync/domains/state/storage');
    initialState = getStorage().getState();
    homeId = await homes.addHome({ name: 'Voice Home', serverUrl: 'https://realtime-tools.test', accountId: 'account-a' });
    homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
    const bearer = homes.findByServerUrl('https://realtime-tools.test')?.token;
    if (!bearer) throw new Error('Expected Account credentials');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: bearer });
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    authScreen = await renderScreen(React.createElement(AuthProvider, { initialCredentials: { token: bearer }, children: null }));
    getStorage().setState({ sessions: { s1: createSessionFixture({
      id: 's1', serverId: homeId, active: true,
      agentState: { requests: {
        req_a: { tool: 'Bash', kind: 'permission', arguments: {} },
        req_b: { tool: 'Read', kind: 'permission', arguments: {} },
      } },
    }) } });
    await setCurrentUiPrivacy('on_demand');
    outgoing.length = 0;

    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: homeId, sessionId: 's1' });
  });

  afterEach(async () => {
    await authScreen?.unmount();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    const { getStorage } = await import('@/sync/domains/state/storage');
    getStorage().setState(initialState, true);
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    vi.restoreAllMocks();
    webLocks.restore();
  });

  it('does not expose speech-driven permission approval as a provider tool', async () => {
    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    const realtimeClientTools = createRealtimeClientTools();

    expect(realtimeClientTools).not.toHaveProperty('processPermissionRequest');
    expect(outgoing).toEqual([]);
  });

  it('routes structured user-action answers through the shared voice handlers', async () => {
    const { getStorage } = await import('@/sync/domains/state/storage');
    getStorage().setState({ sessions: { s1: createSessionFixture({
      id: 's1', serverId: homeId, active: true,
      agentState: { requests: {
        req_question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {} },
        req_permission: { tool: 'Bash', kind: 'permission', arguments: {} },
      } },
    }) } });

    const { createRealtimeClientTools } = await import('./realtimeClientTools');
    const realtimeClientTools = createRealtimeClientTools();

    const result = await realtimeClientTools.answerUserActionRequest({
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(outgoing).toEqual([expect.objectContaining({
      method: 's1:' + RPC_METHODS.SESSION_USER_ACTION_ANSWER,
      params: { id: 'req_question', approved: true, answers: { 'Continue?': ['Yes'] } },
    })]);
  });

  it.each(['on_demand', 'automatic'] as const)(
    'projects current UI reads and effectful opaque commands in %s mode without exposing semantic payloads',
    async (currentUiContextMode) => {
      await setCurrentUiPrivacy(currentUiContextMode);
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

      const result = await tools.readCurrentUiContext({});
      expect(JSON.parse(result)).toEqual(port.readCurrentUiContext());
      expect(result).not.toContain('privateQuery');

      const commandResult = await tools.invokeCurrentUiCommand({
        commandId: 'current-ui-command:1',
      });
      expect(JSON.parse(commandResult)).toEqual({ ok: true, result: { kind: 'navigated' } });
      expect(commandResult).not.toContain('current-ui-command:1');
      expect(commandResult).not.toContain('privateQuery');
      expect(invokeCurrentUiCommand).toHaveBeenCalledWith({
        commandId: 'current-ui-command:1',
      });

      const actionResult = await tools.invokeAction({
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

    await setCurrentUiPrivacy('off');
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

    const stale = await tools.invokeCurrentUiCommand({ commandId: 'current-ui-command:retired' });
    expect(JSON.parse(stale)).toEqual({
      ok: false,
      errorCode: 'stale_surface',
      errorMessage: 'stale_surface',
    });
    expect(stale).not.toContain('current-ui-command:retired');

    const denied = await tools.invokeAction({
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
    await expect(tools.invokeCurrentUiCommand(
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
