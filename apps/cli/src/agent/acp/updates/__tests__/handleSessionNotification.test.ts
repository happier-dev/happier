import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleAcpSessionNotification } from '../handleSessionNotification';
import type { HandlerContext, SessionUpdate } from '../types';

function createHandlerContext(transport: TransportHandler): HandlerContext {
  return {
    transport,
    activeToolCalls: new Set<string>(),
    finalizedToolCalls: new Set<string>(),
    toolCallLifecycleStates: new Map(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    toolCallIdToInputMap: new Map<string, Record<string, unknown>>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (_msg: AgentMessage) => {},
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
  };
}

describe('handleAcpSessionNotification transport hooks', () => {
  it('delegates terminal tool update logging to the transport hook', () => {
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

    handleAcpSessionNotification({
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
});
