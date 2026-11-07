import { describe, expect, it } from 'vitest';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { TeamCredentialResourceDiscoverInputV1Schema, TeamCredentialResourceReadInputV1Schema } from './resourceV1.js';

import {
  TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1,
  TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1,
  TeamCredentialExternalProviderApplicationRequestV1Schema,
  TeamCredentialExternalProviderAdmissionResponseV1Schema,
  TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema,
  TeamCredentialExternalProviderErrorV1Schema,
  TeamCredentialExternalProviderRequestHeadersV1Schema,
  TeamCredentialExternalProviderTerminalUsageV1Schema,
  TeamCredentialResourceTestAdmissionV1Schema,
  TeamCredentialResourceTestApplicationRequestV1Schema,
} from './externalProviderApiV1.js';

const caller = {
  kind: 'external_api_key' as const,
  keyId: '550e8400-e29b-41d4-a716-446655440000',
  assignedAccountId: 'account-1',
  assignedTeamMembershipId: 'membership-1',
};

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1 as const,
    requestId: 'request-1',
    teamId: 'team-1',
    resourceId: 'resource-1',
    caller,
    route: 'chat_completions' as const,
    method: 'POST' as const,
    pathAndQuery: '/v1/chat/completions',
    headers: { 'Bots-Framework': 'happier', 'Content-Type': 'application/json' },
    bodyBase64: Buffer.from('{"model":"test"}').toString('base64'),
    ...overrides,
  };
}

describe('Team credential external Provider API v1', () => {
  it('preserves complete canonical request bodies beyond the retired catalog-derived carrier cap', () => {
    const previousMaxChars = Math.ceil(5 * 1024 * 1024 / 3) * 4;
    for (const chars of [previousMaxChars, previousMaxChars + 4]) {
      const bodyBase64 = 'A'.repeat(chars);
      expect(TeamCredentialExternalProviderApplicationRequestV1Schema.safeParse(request({ bodyBase64 })).success).toBe(true);
      expect(TeamCredentialResourceTestApplicationRequestV1Schema.safeParse({
        v: 1, kind: 'resource_test', requestId: 'test-large', teamId: 'team-1', resourceId: 'resource-1',
        route: 'responses', method: 'POST', pathAndQuery: '/v1/responses', bodyBase64,
      }).success).toBe(true);
    }
  });

  it('publishes one stable base path and an explicit method/path matrix', () => {
    expect(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1).toBe('/api/provider-broker/v1');
    expect(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1.models).toEqual({
      method: 'GET', publicPath: '/models', providerPath: '/v1/models', inference: false,
    });
    expect(Object.keys(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1)).toEqual([
      'models', 'chat_completions', 'responses', 'messages', 'messages_count_tokens',
    ]);
    expect(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1.messages_count_tokens.inference).toBe(false);
  });

  it('accepts one recursively closed external-key application request', () => {
    expect(TeamCredentialExternalProviderApplicationRequestV1Schema.parse(request())).toEqual({
      ...request(),
      headers: { 'bots-framework': 'happier', 'content-type': 'application/json' },
    });
    expect(TeamCredentialExternalProviderApplicationRequestV1Schema.parse(request({
      route: 'models', method: 'GET', pathAndQuery: '/v1/models', bodyBase64: null,
    })).route).toBe('models');
  });

  it('cannot represent caller-selected routing or local managed-service authority', () => {
    for (const forbidden of [
      { machineId: 'caller-selected-machine' },
      { host: '127.0.0.1' },
      { port: 1234 },
      { bearer: 'svc09-secret' },
      { managedServiceHandle: 'private-handle' },
      { sessionId: 'fake-session' },
    ]) {
      expect(TeamCredentialExternalProviderApplicationRequestV1Schema.safeParse({
        ...request(), ...forbidden,
      }).success).toBe(false);
    }
  });

  it('keeps resource tests distinct from external keys and binds exact revision and application', () => {
    const application = {
      agentTargetKey: 'codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'openai-responses',
      protocol: 'openai-responses',
    } as const;
    const testRequest = TeamCredentialResourceTestApplicationRequestV1Schema.parse({
      v: 1,
      kind: 'resource_test',
      requestId: 'test-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      route: 'responses',
      method: 'POST',
      pathAndQuery: '/v1/responses',
      bodyBase64: Buffer.from('{"model":"test","input":"Say OK"}').toString('base64'),
    });
    const source = {
      v: 1 as const,
      kind: 'provider_connection' as const,
      connectionId: 'connection-1',
      connectionSecurityFingerprint: 'connection-security:v1:1',
      credentialSlotId: 'apiKey',
    };
    const verifiedCredentialEvidence = {
      v: 1 as const,
      evidence: [{ kind: 'home_method' as const, methodId: 'email_password' }],
    };
    const binding = {
      v: 1 as const,
      kind: 'resource_test' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      requestId: 'test-1',
      actorAccountId: 'actor-1',
      expectedResourceRevision: 4,
      application,
      source,
      verifiedCredentialEvidence,
    };
    const relayAuthorization = {
      payload: {
        v: 2 as const,
        grantId: 'grant-1',
        accountId: 'custodian-1',
        targetMachineId: 'broker-1',
        flowKind: 'provider_broker' as const,
        routeKind: 'server_relay' as const,
        tunnelId: 'tunnel-1',
        relaySocketId: 'relay-socket-1',
        providerBroker: binding,
        capProfileId: 'server-relay-v1',
        maxFrameBytes: 65_536,
        maxIdleMs: 10_000,
        maxDurationMs: 30_000,
        iat: 1_000,
        exp: 31_000,
        aud: 'happier-tcp-tunnel-relay-authorization' as const,
      },
      signature: { keyId: 'key-1', alg: 'Ed25519' as const, valueBase64Url: 'AA' },
    };
    expect(TeamCredentialResourceTestAdmissionV1Schema.parse({
      v: 1,
      binding,
      brokerMachineId: 'broker-1',
      relayAuthorization,
      requestFacts: {
        generation: true,
        routeKind: 'openai_responses',
        modelId: 'test',
        reasoningEffort: null,
      },
    }).binding).toMatchObject({ application, source, verifiedCredentialEvidence });
    expect(TeamCredentialResourceTestAdmissionV1Schema.safeParse({
      v: 1,
      binding,
      brokerMachineId: 'broker-1',
      requestFacts: {
        generation: true,
        routeKind: 'openai_responses',
        modelId: 'test',
        reasoningEffort: null,
      },
    }).success).toBe(false);
    for (const forbiddenEvidence of [
      { v: 1, evidence: [] },
      { v: 1, evidence: [{ kind: 'home_method', methodId: 'email_password', password: 'secret' }] },
      { v: 1, evidence: [{ kind: 'provider', providerId: 'oidc', identityId: 'identity-1', runtimeFingerprint: 'fingerprint', accessToken: 'secret' }] },
    ]) {
      expect(TeamCredentialResourceTestAdmissionV1Schema.safeParse({
        v: 1,
        binding: {
          v: 1,
          kind: 'resource_test',
          teamId: 'team-1',
          resourceId: 'resource-1',
          requestId: 'test-1',
          actorAccountId: 'actor-1',
          expectedResourceRevision: 4,
          application,
          source,
          verifiedCredentialEvidence: forbiddenEvidence,
        },
        brokerMachineId: 'broker-1',
        relayAuthorization: {
          ...relayAuthorization,
          payload: {
            ...relayAuthorization.payload,
            providerBroker: { ...binding, verifiedCredentialEvidence: forbiddenEvidence },
          },
        },
        requestFacts: {
          generation: true,
          routeKind: 'openai_responses',
          modelId: 'test',
          reasoningEffort: null,
        },
      }).success).toBe(false);
    }
    expect(TeamCredentialResourceTestApplicationRequestV1Schema.safeParse({
      ...testRequest,
      caller,
    }).success).toBe(false);
    expect(TeamCredentialResourceTestAdmissionV1Schema.safeParse({
      v: 1,
      binding: {
        v: 1,
        kind: 'external_api_key',
        teamId: 'team-1',
        resourceId: 'resource-1',
        requestId: 'test-1',
        externalApiKeyId: caller.keyId,
        assignedAccountId: caller.assignedAccountId,
        assignedTeamMembershipId: caller.assignedTeamMembershipId,
      },
      brokerMachineId: 'broker-1',
      requestFacts: {
        generation: true,
        routeKind: 'openai_responses',
        modelId: 'test',
        reasoningEffort: null,
      },
    }).success).toBe(false);
  });

  it('authorizes external model metadata with the exact key, revision, broker and application only', () => {
    const application = {
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'openai-responses',
      protocol: 'openai-responses',
    } as const;
    expect(ProviderBrokerApplicationBindingV1Schema.safeParse(application).success).toBe(false);
    expect(TeamCredentialResourceReadInputV1Schema.safeParse({ teamId: 'team-1', application }).success).toBe(false);
    expect(TeamCredentialResourceDiscoverInputV1Schema.safeParse({ teamIds: ['team-1'], application }).success).toBe(false);
    const authorization = {
      v: 1,
      binding: {
        v: 1,
        kind: 'external_api_key',
        teamId: 'team-1',
        resourceId: 'resource-1',
        requestId: 'models-1',
        externalApiKeyId: caller.keyId,
        operationId: null,
        brokerPlacementFingerprint: 'a'.repeat(64),
        assignedAccountId: caller.assignedAccountId,
        assignedTeamMembershipId: caller.assignedTeamMembershipId,
      },
      brokerMachineId: 'broker-1',
      expectedResourceRevision: 0,
      application,
    } as const;
    expect(TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema.parse(authorization)).toEqual(authorization);
    expect(TeamCredentialExternalProviderAdmissionResponseV1Schema.parse({
      ok: true,
      resourceId: 'resource-1',
      resourceRevision: 0,
      brokerMachineId: 'broker-1',
      source: {
        v: 1,
        kind: 'provider_connection',
        connectionId: 'connection-1',
        connectionSecurityFingerprint: 'connection-security:v1:1',
        credentialSlotId: 'apiKey',
      },
      operation: {
        kind: 'external_api_key',
        operationId: '550e8400-e29b-41d4-a716-446655440001',
        externalApiKeyId: caller.keyId,
        assignedAccountId: caller.assignedAccountId,
        assignedTeamMembershipId: caller.assignedTeamMembershipId,
      },
      usageEventId: null,
      terminalRequestId: null,
    }).resourceRevision).toBe(0);
    for (const forbidden of [
      { requestFacts: { generation: false, modelId: null } },
      { source: { kind: 'provider_connection' } },
      { usageEventId: 'usage-1' },
    ]) {
      expect(TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema.safeParse({
        ...authorization,
        ...forbidden,
      }).success).toBe(false);
    }
  });

  it('binds the external terminal token fact to its measurement', () => {
    const terminal = {
      v: 1 as const,
      admissionUsageEventId: 'usage-1',
      requestId: 'external:key-1:request-1',
      brokerMachineId: 'broker-1',
      completedAtMs: 1_789_000_000_000,
      outcome: 'cancelled' as const,
      measurement: 'unavailable' as const,
      actualModelId: null,
      tokens: null,
    };
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.parse(terminal)).toEqual(terminal);
    const reported = {
      ...terminal,
      outcome: 'succeeded' as const,
      measurement: 'reported' as const,
      actualModelId: 'claude-sonnet-4-5',
      tokens: { input: 11, output: 7, reasoning: 0, cacheRead: 3, cacheWrite: 2, total: 23 },
    };
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.parse(reported)).toEqual(reported);
    // A measurement is the claim; the tokens are its evidence. Neither half may
    // travel without the other, so analytics can never read a reported ceiling
    // contribution that carries no numbers or an unavailable one that does.
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse({
      ...reported,
      tokens: null,
    }).success).toBe(false);
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse({
      ...terminal,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
    }).success).toBe(false);
    // Only the explicitly reported request charge crosses this boundary;
    // estimates and arbitrary cost objects remain outside the broker DTO.
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.parse({
      ...reported, reportedCostUsd: 0,
    })).toMatchObject({ reportedCostUsd: 0 });
    for (const reportedCostUsd of [-1, Infinity, NaN, '0.12']) {
      expect(TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse({ ...reported, reportedCostUsd }).success).toBe(false);
    }
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse({
      ...terminal, reportedCostUsd: 0.1,
    }).success).toBe(false);
    expect(TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse({
      ...reported,
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
    }).success).toBe(false);
  });

  it('rejects route substitution, wildcard paths, and inconsistent methods or bodies', () => {
    for (const invalid of [
      request({ pathAndQuery: '/v1/chat/completions?resourceId=other' }),
      request({ pathAndQuery: '/health' }),
      request({ method: 'GET' }),
      request({ route: 'models', method: 'GET', pathAndQuery: '/v1/models', bodyBase64: request().bodyBase64 }),
      request({ bodyBase64: null }),
      request({ bodyBase64: 'not canonical base64' }),
    ]) {
      expect(TeamCredentialExternalProviderApplicationRequestV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('normalizes only safe forwarded headers and keeps errors closed', () => {
    expect(TeamCredentialExternalProviderRequestHeadersV1Schema.parse({
      'Anthropic-Version': '2023-06-01',
      'Content-Type': 'application/json',
    })).toEqual({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Host', 'Proxy-Authorization', 'X-Happier-Account-Id']) {
      expect(TeamCredentialExternalProviderRequestHeadersV1Schema.safeParse({ [name]: 'secret' }).success).toBe(false);
    }
    expect(TeamCredentialExternalProviderErrorV1Schema.safeParse({
      error: { type: 'happier_provider_broker_error', code: 'broker_unavailable', message: 'Unavailable' },
      resourceId: 'leak',
    }).success).toBe(false);
    expect(TeamCredentialExternalProviderErrorV1Schema.parse({
      error: { type: 'happier_provider_broker_error', code: 'team_credential_usage_limit', message: 'Limited' },
    }).error.code).toBe('team_credential_usage_limit');
    expect(TeamCredentialExternalProviderErrorV1Schema.parse({
      error: { type: 'happier_provider_broker_error', code: 'cost_limit_unavailable', message: 'Unavailable' },
    }).error.code).toBe('cost_limit_unavailable');
    expect(TeamCredentialExternalProviderErrorV1Schema.safeParse({
      error: { type: 'happier_provider_broker_error', code: 'usage_limit_reached', message: 'Legacy ambiguity' },
    }).success).toBe(false);
  });
});
