import type { ToolTraceDirection, ToolTraceEventV1, ToolTraceProtocol } from './toolTrace';

type TraceEventSeed = {
  ts: number;
  protocol: ToolTraceProtocol;
  provider: string;
  kind: string;
  payload: unknown;
  direction?: ToolTraceDirection;
  sessionId?: string;
  localId?: string;
};

export function makeTraceEvent(seed: TraceEventSeed): ToolTraceEventV1 {
  const { direction, sessionId, ...rest } = seed;
  return {
    v: 1,
    ...rest,
    direction: direction ?? 'outbound',
    sessionId: sessionId ?? 's1',
  };
}

export function toJsonlLines(events: ToolTraceEventV1[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

export function scenarioToolResultThenToolCall(): string[] {
  return toJsonlLines([
    makeTraceEvent({
      ts: 1,
      protocol: 'acp',
      provider: 'opencode',
      kind: 'tool-result',
      payload: { type: 'tool-result', callId: 'c1', output: { content: 'ok' } },
    }),
    makeTraceEvent({
      ts: 2,
      protocol: 'acp',
      provider: 'opencode',
      kind: 'tool-call',
      payload: { type: 'tool-call', callId: 'c1', name: 'read', input: { file_path: '/etc/hosts' } },
    }),
  ]);
}

export function scenarioToolResultThenPermissionRequest(): string[] {
  return toJsonlLines([
    makeTraceEvent({
      ts: 1,
      protocol: 'acp',
      provider: 'gemini',
      kind: 'tool-result',
      payload: { type: 'tool-result', callId: 'c1', output: { status: 'ok' } },
    }),
    makeTraceEvent({
      ts: 2,
      protocol: 'acp',
      provider: 'gemini',
      kind: 'permission-request',
      payload: { type: 'permission-request', permissionId: 'c1', toolName: 'read', input: { file_path: '/etc/hosts' } },
    }),
  ]);
}
