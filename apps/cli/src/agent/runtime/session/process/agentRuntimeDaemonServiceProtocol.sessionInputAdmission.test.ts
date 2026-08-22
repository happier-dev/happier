import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
} from './agentRuntimeDaemonServiceProtocol';

const request = {
  v: 1 as const,
  context: { token: 'A'.repeat(43), sessionId: 'session-1' },
  operation: {
    kind: 'session.input.admit' as const,
    requestId: 'admission-1',
    request: {
      v: 1 as const,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'local-1',
      content: {
        t: 'plain' as const,
        v: { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } },
      },
      requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    },
  },
};

describe('Agent runtime daemon Session-input admission service protocol', () => {
  it('accepts only the strict canonical machine-admission request', () => {
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(request)).toEqual(request);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({
      ...request,
      operation: {
        ...request.operation,
        request: { ...request.operation.request, receiptId: 'forbidden' },
      },
    }).success).toBe(false);
  });

  it('returns only the canonical durable admission result', () => {
    const response = {
      ok: true as const,
      result: {
        kind: 'session.input.admission' as const,
        status: 'resolved' as const,
        admission: { status: 'alreadyAccepted' as const, localId: 'local-1' },
      },
    };
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(response)).toEqual(response);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ...response,
      result: { ...response.result, messageId: 'forbidden' },
    }).success).toBe(false);
  });
});
