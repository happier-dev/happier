import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { ProviderBrokerRequestAdmissionV1 } from '@happier-dev/protocol';
import type { ProviderBrokerResourceTestRelayBindingV1 } from '@happier-dev/protocol';
import { ProviderConnectionIdSchema, ProviderConnectionSecurityFingerprintV1Schema } from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1, type TeamCredentialResourceSummaryV1,
  type TeamCredentialResourceTestAdmissionV1 } from '@happier-dev/protocol/teams';

import { createDeferred } from '@/testkit/async/deferred';

import { ApiClient } from './api';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';

const admission: ProviderBrokerRequestAdmissionV1 = {
  v: 1,
  authority: {
    payload: {
      v: 1, grantId: 'grant-1', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
      teamId: 'team-1', resourceId: 'resource-1', sourceRevision: 'source-revision-1',
      brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
      initiator: { accountId: 'recipient', machineId: 'worker', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
      consumer: { kind: 'session', sessionId: 'session-1' },
      application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
      },
    },
    signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) },
  },
  expectedResourceRevision: 0, sourceMemberKey: 'source-member-1', requestId: 'request-1',
  requestFacts: { generation: true, routeKind: 'openai_responses', modelId: 'gpt-5', reasoningEffort: null },
};

const resource: TeamCredentialResourceSummaryV1 = {
  id: 'resource-1', teamId: 'team-1', custodianAccountId: 'custodian', sourceOwnerDisplayName: null,
  displayName: 'Shared source', enabled: true, revision: 0, deliveryPolicy: { preferredAllowedModes: ['brokered'] },
  sessionUsePolicy: 'personal_allowed', source: null,
  sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
  directExportSupport: 'unsupported', activeUsageLimitCount: 0, requestPolicy: null,
  brokerPlacement: { kind: 'machine', machineId: 'broker' }, allMembersAllowedRoutes: null,
  groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
  brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
  capabilities: { manageAudience: false, managePolicy: false, manageLimits: false, updateBrokerPlacement: false,
    updateDeliveryPolicy: false,
    narrowDisclosure: false, widenDisclosure: false, refreshDirectMaterial: false,
    disable: false, enable: false, delete: false },
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};
const testBinding: ProviderBrokerResourceTestRelayBindingV1 = {
  v: 1, kind: 'resource_test', requestId: 'test-request-1', actorAccountId: 'custodian',
  teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 0,
  application: admission.authority.payload.application,
  source: { v: 1, kind: 'provider_connection', connectionId: ProviderConnectionIdSchema.parse('pc_source'),
    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:source'), credentialSlotId: 'apiKey' },
};
const testAdmission: TeamCredentialResourceTestAdmissionV1 = {
  v: 1, binding: testBinding, brokerMachineId: 'broker', requestFacts: admission.requestFacts,
  relayAuthorization: {
    payload: { v: 2, grantId: 'test-relay-grant', accountId: 'custodian', targetMachineId: 'broker',
      flowKind: 'provider_broker', routeKind: 'server_relay', tunnelId: 'test-tunnel', relaySocketId: 'test-relay',
      providerBroker: testBinding, capProfileId: 'server-relay-v1', maxFrameBytes: 65_536,
      maxIdleMs: 10_000, maxDurationMs: 30_000, iat: 100, exp: 200,
      aud: 'happier-tcp-tunnel-relay-authorization' },
    signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'AA' },
  },
};

describe('Provider broker Home admission request lifetime', () => {
  it('accepts a valid Home response beyond the former ten-second phase cutoff', async () => {
    // Real HTTP/Axios observes the former cutoff; no adapter mock can mask it.
    const home = createServer(async (request, response) => {
      await delay(10_100);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url === TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.get']
        ? resource : { ok: false, reasonCode: 'resource_changed' }));
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Home fixture not listening');
    const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    try {
      const options = { signal: new AbortController().signal };
      const results = await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () =>
        await Promise.allSettled([
          api.admitTeamCredentialProviderBrokerRequest(admission, options),
          api.getTeamCredentialResource(resource.id, options),
          api.admitTeamCredentialResourceTestRequest(testAdmission, options),
        ]));
      // Project rejected transport errors to their code so fixture credentials
      // and Axios request bodies never enter a regression diff.
      expect(results.map(result => result.status === 'fulfilled' ? result : {
        status: result.status,
        code: result.reason instanceof Error && 'code' in result.reason ? result.reason.code : 'unexpected_error',
      })).toEqual([
        { status: 'fulfilled', value: { ok: false, reasonCode: 'resource_changed' } },
        { status: 'fulfilled', value: resource },
        { status: 'fulfilled', value: { ok: false, reasonCode: 'resource_changed' } },
      ]);
    } finally {
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('cancels a pending Home admission when the containing request is cancelled', async () => {
    const received = createDeferred();
    const disconnected = createDeferred();
    const home = createServer((_request, response) => {
      response.once('close', () => disconnected.resolve());
      received.resolve();
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Home fixture not listening');
    const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    const controller = new AbortController();
    try {
      const pending = runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () =>
        await api.admitTeamCredentialProviderBrokerRequest(admission, { signal: controller.signal }));
      const result = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
      await received.promise;
      controller.abort();
      await result;
      await disconnected.promise;
    } finally {
      controller.abort();
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close((error) => error ? reject(error) : resolve()));
    }
  });
});
