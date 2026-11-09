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
  it('transports only canonical connected-account observations and acknowledgments', () => {
    const observation = { kind: 'connected-account-identity-observed', sequence: 1,
      sessionId: 'session-1', emittedAtMs: 100, observedAtMs: 99,
      service: { pluginId: 'happier.claude', localId: 'claude-subscription' },
      nativeSessionId: 'native-1', providerOrganizationId: 'org-1' };
    const observed = { ...request, operation: { kind: 'connected_account.identity.observe', observation } };
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(observed)).toEqual(observed);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({ ...observed,
      operation: { ...observed.operation, observation: { ...observation, groupId: 'untrusted' } } }).success).toBe(false);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
      result: { kind: 'connected_account.identity.observed' } })).toEqual({ ok: true,
      result: { kind: 'connected_account.identity.observed' } });
  });
  it('preserves strict target Machine V2 admission through the runner bridge', () => {
    const targeted = {
      ...request,
      operation: {
        ...request.operation,
        request: { ...request.operation.request, v: 2, recipient: { kind: 'execution_run', runId: 'run-a' } },
      },
    };
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(targeted)).toEqual(targeted);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({
      ...targeted, operation: { ...targeted.operation, request: { ...targeted.operation.request, recipient: { kind: 'execution_run', runId: 'run-a', label: 'Not routing' } } },
    }).success).toBe(false);
  });
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
      result: { ...response.result, admission: { status: 'held', localId: 'local-1', code: 'autonomous_check_in' } },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ...response,
      result: { ...response.result, messageId: 'forbidden' },
    }).success).toBe(false);
  });
});
