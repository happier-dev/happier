import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export type AcpSendFn = (
  provider: ACPProvider,
  body: ACPMessageData,
  opts?: { meta?: Record<string, unknown> },
) => void;

export function namespaceSidechainCallId(params: { sidechainId: string; toolCallId: string }): string {
  // Avoid collisions with main-thread tool ids: namespace under the parent tool-call id.
  return `sc:${params.sidechainId}:${params.toolCallId}`;
}

export function forwardAcpMessageDelta(params: {
  sendAcp: AcpSendFn;
  provider: ACPProvider;
  delta: string;
  streamMetaKey: 'happierStreamKey' | 'happierSidechainStreamKey';
  streamKey: string;
  sidechainId?: string;
}): void {
  if (!params.delta) return;
  params.sendAcp(
    params.provider,
    { type: 'message', message: params.delta, ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}) },
    { meta: { [params.streamMetaKey]: params.streamKey } },
  );
}

export function forwardAcpToolCall(params: {
  sendAcp: AcpSendFn;
  provider: ACPProvider;
  callId: string;
  toolName: string;
  input: unknown;
  id: string;
  sidechainId?: string;
}): void {
  params.sendAcp(params.provider, {
    type: 'tool-call',
    callId: params.callId,
    name: params.toolName,
    input: params.input,
    id: params.id,
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
  });
}

export function forwardAcpToolResult(params: {
  sendAcp: AcpSendFn;
  provider: ACPProvider;
  callId: string;
  output: unknown;
  id: string;
  isError?: boolean;
  sidechainId?: string;
}): void {
  params.sendAcp(params.provider, {
    type: 'tool-result',
    callId: params.callId,
    output: params.output,
    id: params.id,
    ...(params.isError !== undefined ? { isError: params.isError } : {}),
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
  });
}
