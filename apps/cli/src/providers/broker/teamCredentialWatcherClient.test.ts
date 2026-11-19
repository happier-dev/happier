import { describe, expect, it, vi } from 'vitest';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import {
  GITHUB_BROKER_WATCHER_V1,
  PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
  ProviderBrokerWatcherOpenResponseV1Schema,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerWatcherOpenRequestV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { createTeamCredentialWatcherRead } from './teamCredentialWatcherClient';

describe('Team credential watcher reads', () => {
  it('opens one authority for multiple finite GETs and keeps service credentials out of the requester', async () => {
    const { service, attemptActionId, backgroundServiceId, purposeId } = GITHUB_BROKER_WATCHER_V1;
    const purpose = { consumer: { pluginId: service.pluginId, localId: attemptActionId }, purpose: purposeId };
    const brokerOpen = ProviderBrokerWatcherOpenResponseV1Schema.parse({
      ok: true,
      authority: {
        payload: {
          v: 1, scope: 'automation_event_watcher', aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
          grantId: 'grant', issuedAt: 1000, expiresAt: 2000, teamId: 'team', resourceId: 'resource', resourceRevision: 1,
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
    const openBroker = vi.fn(async (_request: ProviderBrokerWatcherOpenRequestV1) => brokerOpen);
    const close = vi.fn(async () => {});
    const openTunnel = vi.fn(async () => ({ localPort: 1234, localCapability: 'carrier-only', observedPath: 'direct' as const,
      close, retire: close }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]', { headers: { etag: 'v2' } }));
    const read = createTeamCredentialWatcherRead({
      caller: { pluginId: service.pluginId, contributionLocalId: backgroundServiceId, occurrenceId: 'occurrence',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation', installSource: 'archive' },
        materialization: { pluginId: service.pluginId, machineId: 'watcher', materializationId: 'materialization' } },
      teamId: 'team', resourceId: 'resource', purpose, repository: { owner: 'acme', name: 'widget', repositoryId: '42' },
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
      v: 1, scope: 'automation_event_watcher', resourceId: 'resource', initiatorMachineId: 'watcher', caller: expect.any(Object),
    });
    expect(openTunnel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:1234/v1/repos/acme/widget/events?per_page=30',
      'http://127.0.0.1:1234/v1/repositories/42/events?page=2',
    ]);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${encodeProviderBrokerAuthorityV1(brokerOpen.authority)}`);
    expect(headers.get(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER)).toBe('carrier-only');
    expect(headers.get('If-None-Match')).toBe('v1');
    await expect(read.adapter.request({ url: 'https://api.github.com/repos/acme/other/events', redirect: 'error' }, opts))
      .rejects.toMatchObject({ code: 'broker_binding_changed' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await read.dispose();
    await expect(read.adapter.request({ url: first, redirect: 'error' }, opts)).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });
});
