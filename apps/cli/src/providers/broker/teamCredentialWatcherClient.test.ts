import { describe, expect, it, vi } from 'vitest';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS } from '@happier-dev/protocol';
import {
  GITHUB_BROKER_WATCHER_V1,
  PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
  ProviderBrokerWatcherOpenResponseV1Schema,
  ProviderBrokerWatcherRefreshRequestV1Schema,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerWatcherRefreshResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { createTeamCredentialWatcherRead, type TeamCredentialWatcherTransport } from './teamCredentialWatcherClient';

describe('Team credential watcher reads', () => {
  it('opens one authority for multiple finite GETs and keeps service credentials out of the requester', async () => {
    const { service, attemptActionId, backgroundServiceId, purposeId } = GITHUB_BROKER_WATCHER_V1;
    const purpose = { consumer: { pluginId: service.pluginId, localId: attemptActionId }, purpose: purposeId };
    const activation = ProviderBrokerWatcherRefreshRequestV1Schema.shape.activation.parse({ automationId: 'automation',
      triggerId: 'trigger', triggerRevision: 1, sourceSelectorId: '00000000-0000-4000-8000-000000000001' });
    const issuedAt = Date.now();
    const expiresAt = issuedAt + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel;
    const brokerOpen = ProviderBrokerWatcherOpenResponseV1Schema.parse({
      ok: true,
      authority: {
        payload: {
          v: 1, scope: 'automation_event_watcher', aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
          grantId: 'grant', issuedAt, expiresAt, teamId: 'team', resourceId: 'resource', resourceRevision: 1,
          activationBinding: 'f'.repeat(64),
          initiator: { accountId: 'requester', machineId: 'watcher', endpointId: 'a'.repeat(64) },
          target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
          consumer: { occurrenceId: 'occurrence', purpose },
          source: { v: 1, kind: 'connected_account', target: { kind: 'account', account: { service, accountId: 'source' } },
            credentialIncarnation: 'current' },
        },
        signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.alloc(64).toString('base64url') },
      },
      target: { custodianAccountId: 'custodian', brokerMachineId: 'broker', endpointId: 'b'.repeat(64), endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) } },
    });
    if (!brokerOpen.ok) throw new Error('Invalid test authority');
    const controller = new AbortController();
    const openBroker = vi.fn<TeamCredentialWatcherTransport['openBroker']>(async () => brokerOpen);
    const close = vi.fn(async () => {});
    const openTunnel = vi.fn<TeamCredentialWatcherTransport['openTunnel']>(async () => ({ localPort: 1234, localCapability: 'carrier-only', observedPath: 'direct',
      close, retire: close }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]', { headers: { etag: 'v2' } }));
    const read = createTeamCredentialWatcherRead({
      caller: { pluginId: service.pluginId, contributionLocalId: backgroundServiceId, occurrenceId: 'occurrence',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation', installSource: 'archive' },
        materialization: { pluginId: service.pluginId, machineId: 'watcher', materializationId: 'materialization' } },
      teamId: 'team', resourceId: 'resource', purpose, activation, repository: { owner: 'acme', name: 'widget', repositoryId: '42' },
      openBroker, openTunnel, fetchImpl,
    });
    const opts = { signal: controller.signal };
    const first = 'https://api.github.com/repos/acme/widget/events?per_page=30';
    const second = 'https://api.github.com/repositories/42/events?page=2';
    const http = createStablePluginHttpHost({ adapter: { ...read.adapter, async request() {
      throw new Error('Watchers must use the bound transport');
    } } }).bind({
      plugin: { id: service.pluginId, version: '1.0.0' },
      contribution: { id: attemptActionId, qualifiedId: `${service.pluginId}/actions/${attemptActionId}` },
      occurrenceId: 'occurrence', correlationId: 'watcher-read', surface: 'plugin',
      signal: controller.signal, isOccurrenceCurrent: () => true,
    }, { ...createPluginInvocationServiceBinding('occurrence', 'watcher-binding'), watcherHttpAdapter: read.adapter });
    const [firstRead, secondRead] = await Promise.all([
      http.prepareRead({ intent: 'get', url: first, redirect: 'error', headers: { 'If-None-Match': 'v1' } }, opts),
      http.prepareRead({ intent: 'get', url: second, redirect: 'error' }, opts),
    ]);
    expect(openBroker).not.toHaveBeenCalled();
    const [firstResult, secondResult] = await Promise.all([firstRead.request(opts), secondRead.request(opts)]);
    expect(firstResult).toMatchObject({ status: 200, finalUrl: first, headers: { etag: 'v2' } });
    expect(secondResult.finalUrl).toBe(second);
    expect(openBroker).toHaveBeenCalledOnce();
    expect(openBroker.mock.calls[0]?.[0]).toEqual({
      v: 1, scope: 'automation_event_watcher', resourceId: 'resource', initiatorMachineId: 'watcher', caller: expect.any(Object), activation,
    });
    expect(openTunnel).toHaveBeenCalledOnce();
    const timelineTarget = 'http://127.0.0.1:1234/v1/repos/acme/widget/events?per_page=30';
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      timelineTarget,
      'http://127.0.0.1:1234/v1/repositories/42/events?page=2',
    ]));
    const headers = new Headers(fetchImpl.mock.calls.find(([url]) => url === timelineTarget)?.[1]?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${encodeProviderBrokerAuthorityV1(brokerOpen.authority)}`);
    expect(headers.get(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER)).toBe('carrier-only');
    expect(headers.get('If-None-Match')).toBe('v1');
    await expect(read.adapter.request({ url: 'https://api.github.com/repos/acme/other/events', redirect: 'error' }, opts))
      .rejects.toMatchObject({ code: 'broker_binding_changed' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const renewed = { ok: true, authority: { ...brokerOpen.authority, payload: { ...brokerOpen.authority.payload,
      grantId: 'renewed-grant', issuedAt: expiresAt, expiresAt: expiresAt + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
    } } } satisfies ProviderBrokerWatcherRefreshResponseV1;
    const renewalBearer = `Bearer ${encodeProviderBrokerAuthorityV1(renewed.authority)}`;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
    try {
      openBroker.mockResolvedValueOnce(renewed);
      fetchImpl.mockImplementation(async (_url, init) => {
        return new Response('[]', { status: new Headers(init?.headers).get('authorization') === renewalBearer ? 200 : 403 });
      });
      const reads = await Promise.all([
        read.adapter.request({ url: first, redirect: 'error' }, opts),
        read.adapter.request({ url: second, redirect: 'error' }, opts),
      ]);
      expect(reads.map(result => result.status)).toEqual([200, 200]);
      expect(openBroker).toHaveBeenCalledTimes(2);
      expect(openBroker.mock.calls[1]?.[0]).toEqual({ ...openBroker.mock.calls[0]?.[0], refreshAuthority: brokerOpen.authority });
      expect(openTunnel).toHaveBeenCalledOnce();
      await expect(openTunnel.mock.calls[0]?.[0].refreshBrokerOpen()).resolves.toEqual({ ...renewed, target: brokerOpen.target });
      expect(openBroker).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(renewed.authority.payload.expiresAt - ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS);
      openBroker.mockResolvedValueOnce({ ok: false, reasonCode: 'resource_unavailable' });
      await expect(read.adapter.request({ url: first, redirect: 'error' }, opts)).rejects.toMatchObject({ code: 'resource_unavailable' });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      await read.dispose();
      await expect(read.adapter.request({ url: first, redirect: 'error' }, opts)).rejects.toMatchObject({ name: 'AbortError' });
      expect(openBroker).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      await read.dispose();
    }
  });
});
