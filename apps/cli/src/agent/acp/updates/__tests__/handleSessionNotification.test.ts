import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { TransportHandler } from '@/agent/transport';

import { handleAcpSessionNotification } from '../handleSessionNotification';
import type { HandlerContext, SessionUpdate } from '../types';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';

function createHandlerContext(transport: TransportHandler): HandlerContext {
  return createLegacyHandlerContextFixture({ transport });
}

describe('handleAcpSessionNotification transport hooks', () => {
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
