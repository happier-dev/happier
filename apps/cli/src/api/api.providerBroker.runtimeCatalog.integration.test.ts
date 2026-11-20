import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import {
  projectPrivateLabelForRecipientV1,
  PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
  PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1,
  sealPrivateLabelV1,
} from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1, TeamCredentialResourceSummaryV1Schema } from '@happier-dev/protocol/teams';

import { ApiClient } from './api';

vi.mock('@/configuration', () => ({
  configuration: { apiServerUrl: 'https://home.example' },
}));

describe('ApiClient Team credential Provider broker methods', () => {
  let api: ApiClient;
  let app: FastifyInstance;
  let restoreAdapter: () => void;

  beforeEach(async () => {
    app = fastify();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'https://home.example' });
    api = await ApiClient.create({
      token: 'account-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
  });

  afterEach(async () => {
    restoreAdapter();
    await app.close();
  });

  it('reads the current custodian resource projection through its canonical Action route', async () => {
    const resource = TeamCredentialResourceSummaryV1Schema.parse({
      id: 'resource-1',
      teamId: 'team-1',
      custodianAccountId: 'account-1',
      displayName: projectPrivateLabelForRecipientV1({
        recipientAccountId: 'account-1',
        stored: sealPrivateLabelV1({
          mode: 'plain',
          value: 'Shared Codex',
          binding: { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' },
        }),
      }),
      enabled: true,
      revision: 7,
      deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'personal_allowed',
      source: null,
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      },
      requestPolicy: null,
      brokerPlacement: { kind: 'machine', machineId: 'broker-1' },
      allMembersAllowedRoutes: null,
      groupGrants: [],
      memberGrants: [],
      readiness: { kind: 'available' },
      recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    app.post(TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.get'], async (incoming) => {
      expect(incoming.body).toEqual({ resourceId: 'resource-1' });
      expect(incoming.headers.authorization).toBe('Bearer account-token');
      return resource;
    });

    await expect(api.getTeamCredentialResource('resource-1')).resolves.toEqual(resource);
  });

  it('opens a broker authority through the canonical typed endpoint', async () => {
    const request = {
      v: 1 as const,
      resourceId: 'resource-1',
      expectedResourceRevision: 1,
      modelId: 'gpt-5',
      sourceRevision: 'source-revision-1',
      initiatorMachineId: 'worker-1',
      consumer: { kind: 'session' as const, sessionId: 'session-1' },
      application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses' as const,
      },
    };
    const response = { ok: false as const, reasonCode: 'broker_unavailable' as const };
    app.post(PROVIDER_BROKER_OPEN_HTTP_PATH_V1, async (incoming) => {
      expect(incoming.body).toEqual(request);
      expect(incoming.headers.authorization).toBe('Bearer account-token');
      return response;
    });

    await expect(api.openTeamCredentialProviderBroker(request)).resolves.toEqual(response);
  });

  it('admits each Provider request through the canonical typed endpoint', async () => {
    const request = {
      v: 1 as const,
      authority: {
        payload: {
          v: 1 as const,
          grantId: 'grant-1',
          aud: 'happier-provider-broker-route-v1' as const,
          issuedAt: 1,
          expiresAt: 2,
          teamId: 'team-1',
          resourceId: 'resource-1',
          sourceRevision: 'source-revision-1',
          brokerPlacementFingerprint: 'c'.repeat(64),
          initiatorTokenEpoch: 0,
          initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
          target: { custodianAccountId: 'account-2', machineId: 'broker-1', endpointId: 'b'.repeat(64) },
          consumer: { kind: 'session' as const, sessionId: 'session-1' },
          application: {
            agentTargetKey: 'codex',
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'cliproxyapi-openai-responses',
            protocol: 'openai-responses' as const,
          },
        },
        signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: 'A'.repeat(86) },
      },
      expectedResourceRevision: 1,
      sourceMemberKey: 'source-member-1',
      requestId: 'request-1',
      requestFacts: { generation: false, routeKind: 'openai_responses' as const, modelId: 'gpt-5', reasoningEffort: null },
    };
    const response = { ok: false as const, reasonCode: 'resource_changed' as const };
    app.post(PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1, async (incoming) => {
      expect(incoming.body).toEqual(request);
      expect(incoming.headers.authorization).toBe('Bearer account-token');
      return response;
    });

    await expect(api.admitTeamCredentialProviderBrokerRequest(request)).resolves.toEqual(response);
  });
});
