import type { AgentMessage } from '@/agent/core';
import { DefaultTransport, type TransportHandler } from '@/agent/transport';
import { LegacyAcpToolRuntime } from '../toolCalls/legacy/runtime';
import type { HandlerContext } from '../updates/types';

export function createLegacyHandlerContextFixture(params?: Readonly<{
  transport?: TransportHandler;
  emit?: (message: AgentMessage) => void;
  toolCallCountSincePrompt?: number;
}>): HandlerContext {
  const transport = params?.transport ?? new DefaultTransport('test');
  const emit = params?.emit ?? (() => undefined);
  const toolCalls = new LegacyAcpToolRuntime({
    sessionId: () => 'session-1',
    turnId: () => 'turn-1',
    sidechainId: null,
    emit,
    transport,
    onBecameActive: () => undefined,
    onBecameIdle: () => undefined,
  });
  return {
    transport,
    toolCalls,
    idleTimeout: null,
    toolCallCountSincePrompt: params?.toolCallCountSincePrompt ?? 0,
    emit,
    emitIdleStatus: () => undefined,
    clearIdleTimeout: () => undefined,
    setIdleTimeout: () => undefined,
  };
}
