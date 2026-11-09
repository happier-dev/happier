import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { TransportHandler } from '@/agent/transport';
import type { AgentSessionModelsSnapshot, AgentSessionModesSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPublicAcpSessionCatalogs } from '../../runtime/publicSession/publicAcpSessionCatalogs';
import type { SessionModeState, SessionModelState } from '../../sessionSettings/sessionSettingsState';

import { handleAcpSessionNotification } from '../handleSessionNotification';
import type { HandlerContext, SessionUpdate } from '../types';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';

function createHandlerContext(transport: TransportHandler): HandlerContext {
  return createLegacyHandlerContextFixture({ transport });
}

describe('handleAcpSessionNotification transport hooks', () => {
  it.each(['update', 'updates'])('handles every admitted compatibility batch item in %s, including its terminal tail', async (field) => {
    const messages: AgentMessage[] = [];
    const transport: TransportHandler = { agentName: 'native-acp', getInitTimeout: () => 1_000, getToolPatterns: () => [] };
    const updates = [
      ...Array.from({ length: 1_000 }, (_, index) => ({ sessionUpdate: 'session_info_update', title: `row-${index}` })),
      { sessionUpdate: 'tool_call', toolCallId: 'tail', title: 'Build', status: 'completed', kind: 'execute', rawOutput: { stdout: 'built' } },
    ];
    const context = createLegacyHandlerContextFixture({ transport, emit: message => messages.push(message) });
    await handleAcpSessionNotification({
      notification: { sessionId: 'native-session', [field]: updates } as unknown as SessionNotification,
      agentName: transport.agentName, transport, replayCapture: null, waitingForResponse: false,
      onResponseTrafficObserved: () => {}, onAssistantMessageObserved: () => {},
      createHandlerContext: () => context, setToolCallCountSincePrompt: () => {}, emit: message => messages.push(message),
      sessionModeState: null, setSessionModeState: () => {}, sessionModelState: null, setSessionModelState: () => {},
      sessionConfigOptionsState: null, setSessionConfigOptionsState: () => {},
    });
    expect(messages.flatMap(message => message.type === 'event' && message.name === 'session_info_update' ? [message.payload] : []))
      .toEqual(updates.slice(0, -1));
    expect(messages.at(-1)).toMatchObject({ type: 'tool-result', callId: 'tail', result: expect.objectContaining({ stdout: 'built' }) });
    context.toolCalls.dispose();
  });

  it('publishes only changed selections and retains catalog identities through native notifications', async () => {
    let model: SessionModelState = { currentModelId: 'a', availableModels: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    let mode: SessionModeState = { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    const models: AgentSessionModelsSnapshot[] = [];
    const modes: AgentSessionModesSnapshot[] = [];
    const catalogs = createPublicAcpSessionCatalogs({
      backend: { getSessionModelState: () => model, getSessionModeState: () => mode, getSessionConfigOptionsState: () => null },
      models: { bind: source => source.subscribe(snapshot => models.push(snapshot)) },
      modes: { bind: source => source.subscribe(snapshot => modes.push(snapshot)) }, publish: () => {},
    });
    catalogs.open();
    const initialModels = models.at(-1)!;
    const initialModes = modes.at(-1)!;
    models.length = modes.length = 0;
    const transport: TransportHandler = { agentName: 'native-acp', getInitTimeout: () => 1000, getToolPatterns: () => [] };
    const emit = (message: AgentMessage) => catalogs.observe(message);
    const observe = (currentModelId: string, currentModeId: string) => handleAcpSessionNotification({
      notification: { sessionId: 'native-session', update: [
        { sessionUpdate: 'current_model_update', currentModelId }, { sessionUpdate: 'current_mode_update', currentModeId },
      ] } as unknown as SessionNotification,
      agentName: transport.agentName, transport, replayCapture: null, waitingForResponse: false,
      onResponseTrafficObserved: () => {}, onAssistantMessageObserved: () => {},
      createHandlerContext: () => createLegacyHandlerContextFixture({ transport, emit }),
      setToolCallCountSincePrompt: () => {}, emit,
      sessionModelState: model, setSessionModelState: state => { if (!state) throw new Error('Expected models'); model = state; },
      sessionModeState: mode, setSessionModeState: state => { mode = state; },
      sessionConfigOptionsState: null, setSessionConfigOptionsState: () => {},
    });
    try {
      for (let index = 0; index < 100; index++) await observe('a', 'a');
      expect(models).toHaveLength(0);
      expect(modes).toHaveLength(0);
      await observe('b', 'b');
      expect(models).toHaveLength(1);
      expect(modes).toHaveLength(1);
      expect(models[0]?.currentModelId).toBe('b');
      expect(modes[0]?.currentModeId).toBe('b');
      expect(models[0]?.models).toBe(initialModels.models);
      expect(modes[0]?.modes).toBe(initialModes.modes);
      expect(models[0]?.models?.[0]).toBe(initialModels.models?.[0]);
      for (let index = 0; index < 100; index++) await observe('b', 'b');
      expect(models).toHaveLength(1);
      expect(modes).toHaveLength(1);
      model = { ...model, availableModels: model.availableModels.map(row => row.id === 'b' ? { ...row, name: 'B revised' } : { ...row }) };
      mode = { ...mode, availableModes: mode.availableModes.map(row => row.id === 'b' ? { ...row, name: 'B revised' } : { ...row }) };
      catalogs.observe({ type: 'event', name: 'session_models_state', payload: model });
      catalogs.observe({ type: 'event', name: 'session_modes_state', payload: mode });
      expect(models).toHaveLength(2);
      expect(modes).toHaveLength(2);
      expect(models[1]?.models?.[0]).toBe(initialModels.models?.[0]);
      expect(modes[1]?.modes?.[0]).toBe(initialModes.modes?.[0]);
      expect(models[1]?.models?.[1]?.name).toBe('B revised');
      expect(modes[1]?.modes?.[1]?.name).toBe('B revised');
    } finally { await catalogs.dispose(); }
  });

  it('retains native session info outside prompt traffic, including extension metadata', async () => {
    // FX 0.0.14 captured 2026-10-27, E-fx-live-probe.md:226.
    const update = {
      sessionUpdate: 'session_info_update' as const,
      title: 'Request to Reply OK',
      updatedAt: '2026-10-27T09:51:22Z',
      _meta: { 'fixture/native': { status: 'ready' } },
    };
    const messages: AgentMessage[] = [];
    const transport: TransportHandler = {
      agentName: 'native-acp', getInitTimeout: () => 1_000, getToolPatterns: () => [],
    };
    await handleAcpSessionNotification({
      notification: { sessionId: 'native-session', update },
      agentName: transport.agentName, transport, replayCapture: null, waitingForResponse: false,
      onResponseTrafficObserved: () => { throw new Error('Session info is not prompt traffic'); },
      onAssistantMessageObserved: () => { throw new Error('Session info is not assistant output'); },
      createHandlerContext: () => createHandlerContext(transport),
      setToolCallCountSincePrompt: () => {}, emit: (message) => messages.push(message),
      sessionModeState: null, setSessionModeState: () => {},
      sessionModelState: null, setSessionModelState: () => {},
      sessionConfigOptionsState: null, setSessionConfigOptionsState: () => {},
    });
    expect(messages).toEqual([{ type: 'event', name: 'session_info_update', payload: update }]);
  });

  it('delegates terminal tool update logging to the transport hook', async () => {
    const logged: Array<Readonly<{
      update: unknown;
      sessionUpdateType: string;
    }>> = [];
    const transport: TransportHandler & {
      logTerminalToolUpdate: NonNullable<TransportHandler['logTerminalToolUpdate']>;
    } = {
      agentName: 'provider-with-hook',
      getInitTimeout: () => 1_000,
      getToolPatterns: () => [],
      logTerminalToolUpdate: (update, context) => {
        logged.push({ update, sessionUpdateType: context.sessionUpdateType });
      },
    };
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      kind: 'execute',
    };

    await handleAcpSessionNotification({
      notification: { update } as unknown as SessionNotification,
      agentName: 'provider-with-hook',
      transport,
      replayCapture: null,
      waitingForResponse: false,
      onResponseTrafficObserved: () => {},
      onAssistantMessageObserved: () => {},
      createHandlerContext: () => createHandlerContext(transport),
      setToolCallCountSincePrompt: () => {},
      emit: () => {},
      sessionModeState: null,
      setSessionModeState: () => {},
      sessionModelState: null,
      setSessionModelState: () => {},
      sessionConfigOptionsState: null,
      setSessionConfigOptionsState: () => {},
    });

    expect(logged).toEqual([{ update, sessionUpdateType: 'tool_call_update' }]);
  });

  it('awaits remote tool preparation in provider order before handling updates', async () => {
    const order: string[] = [];
    const transport: TransportHandler = {
      agentName: 'remote-provider',
      getInitTimeout: () => 1_000,
      getToolPatterns: () => [],
      logTerminalToolUpdate: (update) => {
        order.push(`handled:${String(Reflect.get(update, 'kind'))}`);
      },
    };
    const first: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      kind: 'unresolved-first',
    };
    const second: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-2',
      status: 'completed',
      kind: 'unresolved-second',
    };

    await handleAcpSessionNotification({
      notification: { update: [first, second] } as unknown as SessionNotification,
      agentName: 'remote-provider',
      transport,
      replayCapture: null,
      waitingForResponse: false,
      onResponseTrafficObserved: () => {},
      onAssistantMessageObserved: () => {},
      prepareToolUpdate: async (update) => {
        order.push(`prepare:${String(update.kind)}`);
        await Promise.resolve();
        return { ...update, kind: String(update.kind).replace('unresolved-', '') };
      },
      createHandlerContext: () => createHandlerContext(transport),
      setToolCallCountSincePrompt: () => {},
      emit: () => {},
      sessionModeState: null,
      setSessionModeState: () => {},
      sessionModelState: null,
      setSessionModelState: () => {},
      sessionConfigOptionsState: null,
      setSessionConfigOptionsState: () => {},
    });

    expect(order).toEqual([
      'prepare:unresolved-first',
      'handled:first',
      'prepare:unresolved-second',
      'handled:second',
    ]);
  });

  it('does not pass a provider-suppressed tool update into canonical handling', async () => {
    const handled: string[] = [];
    const transport: TransportHandler = {
      agentName: 'provider-with-pressure-policy',
      getInitTimeout: () => 1_000,
      getToolPatterns: () => [],
      logTerminalToolUpdate: (update) => handled.push(String(Reflect.get(update, 'toolCallId'))),
    };

    await handleAcpSessionNotification({
      notification: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'suppressed',
          status: 'completed',
        },
      } as unknown as SessionNotification,
      agentName: transport.agentName,
      transport,
      replayCapture: null,
      waitingForResponse: false,
      onResponseTrafficObserved: () => {},
      onAssistantMessageObserved: () => {},
      prepareToolUpdate: async () => null,
      createHandlerContext: () => createHandlerContext(transport),
      setToolCallCountSincePrompt: () => {},
      emit: () => {},
      sessionModeState: null,
      setSessionModeState: () => {},
      sessionModelState: null,
      setSessionModelState: () => {},
      sessionConfigOptionsState: null,
      setSessionConfigOptionsState: () => {},
    });

    expect(handled).toEqual([]);
  });
});
