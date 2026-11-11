import { describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveTeamCredentialResourceSourceCatalogs } from './resourceTestCandidate';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';
import { startProviderBrokerApplicationServer } from './providerBrokerApplicationServer';
import { createProviderBrokerEndpointDiscovery } from './providerBrokerEndpointDiscovery';
import { resolveTeamCredentialExternalRequestPolicy } from './externalRequestPolicy';

describe('broker source failure projection', () => {
  it.each(['provider_incompatible_with_agent', 'provider_endpoint_rate_limited', 'connected_service_credential_reconnect_required'] as const)(
    'retains %s from the custodian catalog to the recipient endpoint reader', async code => {
      // The source Account holds the credential; the recipient sees only its
      // resource and closed refusal, never the source Account's private error.
      const readCatalog = () => resolveTeamCredentialResourceSourceCatalogs({
        machineId: 'custodian-machine', teamId: 'team', resourceId: 'shared-resource', expectedResourceRevision: 2,
        source: { v: 1, kind: 'connected_pool', target: { kind: 'group',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'custodian-pool' },
          poolIncarnation: 'pool-incarnation' },
        readSourceModelCatalogs: async () => ({ status: 'error', error: createProviderErrorV1(code) }),
      }).catch(preserveBrokerSourceHealthFailure);
      const server = await startProviderBrokerApplicationServer({
        handler: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
        localConsumer: { authorize: () => true, request: async () => {
          await readCatalog(); return { ok: false, reasonCode: 'resource_unavailable' };
        } },
      });
      try {
        await expect(createProviderBrokerEndpointDiscovery().readEndpointUrl({
          localOrigin: server.localConsumerEndpointUrl!, headers: {}, signal: new AbortController().signal,
        })).rejects.toMatchObject({ code });
      } finally { await server.close(); }
    });
});

describe('external broker source failure projection', () => {
  it('preserves the source catalog refusal rather than reporting a forbidden route', async () => {
    const source = { v: 1, kind: 'connected_pool', target: { kind: 'group',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool' }, poolIncarnation: 'incarnation' } as const;
    await expect(resolveTeamCredentialExternalRequestPolicy({ machineId: 'custodian',
      binding: { v: 1, kind: 'external_api_key', teamId: 'team', resourceId: 'shared-resource', requestId: 'request',
        externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000', operationId: null,
        brokerPlacementFingerprint: 'a'.repeat(64), assignedAccountId: 'recipient', assignedTeamMembershipId: 'member' },
      request: { method: 'POST', pathAndQuery: '/v1/responses' },
      readResource: async () => ({ id: 'shared-resource', teamId: 'team', revision: 2, enabled: true,
        brokerPlacement: { kind: 'machine', machineId: 'custodian' }, source, requestPolicy: null }),
      readSourceModelCatalogs: async () => ({ status: 'error', error: createProviderErrorV1('provider_endpoint_rate_limited') }),
    })).rejects.toMatchObject({ failure: { ok: false, reasonCode: 'provider_endpoint_rate_limited' } });
  });
});
