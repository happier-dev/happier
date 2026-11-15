import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
} from './agentRuntimeDaemonServiceProtocol';

const createOpenedTeamProviderBindingResponse = (resourceId: string) => ({
  ok: true as const,
  result: {
    kind: 'provider_broker.binding' as const,
    status: 'opened' as const,
    providerBinding: {
      source: {
        kind: 'team_resource' as const,
        resourceId,
        resourceRevision: 3,
      },
      model: { id: 'model-1', name: 'Model 1' },
      upstream: {
        protocol: 'openai-responses' as const,
        normalizedUrl: 'http://127.0.0.1:43123/v1',
        credential: 'apiKey' as const,
      },
      materialization: { v: 1 as const, kind: 'spawnEnv' as const },
    },
    environmentOverlay: [],
    additionalRedactionValues: [],
  },
});

describe('Agent runtime daemon provider binding service protocol', () => {
  it('carries a turn-scoped closed Team credential refusal without private broker facts', () => {
    const request = {
      v: 1,
      context: { token: 'A'.repeat(43), sessionId: 'session-1' },
      operation: { kind: 'provider_broker.refusal.read', requestId: 'request-1', turnId: 'turn-1' },
    };
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(request)).toEqual(request);
    const denial = { v: 1, resourceId: 'resource-1', reasonCode: 'resource_forbidden' };
    const carrierFailure = { closingSide: 'initiator', closingStage: 'local_http_head' };
    const carrierResponse = { ok: true, result: { kind: 'provider_broker.refusal', denial: null, carrierFailure } };
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(carrierResponse)).toEqual(carrierResponse);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({ ...carrierResponse, result: { ...carrierResponse.result,
      carrierFailure: { ...carrierFailure, nativeMessage: 'PRIVATE_DETAIL' } } }).success).toBe(false);
    const response = { ok: true, result: { kind: 'provider_broker.refusal', denial } };
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(response)).toEqual(response);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse({
      ok: true, result: { kind: 'provider_broker.refusal', denial: null },
    })).toEqual({ ok: true, result: { kind: 'provider_broker.refusal', denial: null } });
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ...response, result: { ...response.result, denial: { ...denial, memberId: 'private-member' } },
    }).success).toBe(false);
  });

  it('uses the canonical Team provider binding resource-id boundary', () => {
    const maximumLengthResponse = createOpenedTeamProviderBindingResponse(
      'r'.repeat(256),
    );

    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.parse(maximumLengthResponse),
    ).toEqual(maximumLengthResponse);
    expect(
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse(
        createOpenedTeamProviderBindingResponse('r'.repeat(257)),
      ).success,
    ).toBe(false);
  });

  it('carries exact Execution Run open identity and an opaque terminal cleanup handle', () => {
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse({
      v: 1,
      context: { token: 'A'.repeat(43), sessionId: 'session-1' },
      operation: {
        kind: 'provider_broker.binding.open', requestId: 'request-1',
        resourceId: 'resource-1', expectedResourceRevision: 3,
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
        consumer: { kind: 'execution_run', executionRunId: 'run-1' },
        teamId: 'team-b',
        deliveryMode: 'direct',
      },
    }).operation).toMatchObject({
      consumer: { kind: 'execution_run', executionRunId: 'run-1' },
      teamId: 'team-b',
      deliveryMode: 'direct',
    });
    const response = AgentRuntimeDaemonServiceResponseV1Schema.parse({
      ...createOpenedTeamProviderBindingResponse('resource-1'),
      result: {
        ...createOpenedTeamProviderBindingResponse('resource-1').result,
        bindingId: 'binding-1',
      },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('Expected a successful provider binding response');
    expect(response.result).toMatchObject({ bindingId: 'binding-1' });
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse({
      v: 1,
      context: { token: 'A'.repeat(43), sessionId: 'session-1' },
      operation: {
        kind: 'provider_broker.binding.close', requestId: 'request-2', bindingId: 'binding-1',
      },
    }).operation.kind).toBe('provider_broker.binding.close');
  });
});
