import { createFetchPluginHttpRuntime, raceWithAbort } from '@happier-dev/cli-common/plugins/http';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  ProviderBrokerWatcherOpenRequestV1Schema,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerWatcherOpenRequestV1,
  type ProviderBrokerWatcherOpenResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import type { ProviderBrokerMachineCarrierTunnel } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { PluginHttpRuntimeAdapter } from '@/plugins/runtime/fetch/service';

type OpenedWatcherBroker = Extract<ProviderBrokerWatcherOpenResponseV1, { ok: true }>;

export type TeamCredentialWatcherTransport = Readonly<{
  openBroker(request: ProviderBrokerWatcherOpenRequestV1, signal: AbortSignal): Promise<ProviderBrokerWatcherOpenResponseV1>;
  openTunnel(request: Readonly<{ brokerOpen: OpenedWatcherBroker; signal: AbortSignal }>): Promise<ProviderBrokerMachineCarrierTunnel>;
}>;

export type TeamCredentialWatcherRepository = Readonly<{ owner: string; name: string; repositoryId: string }>;

/** The adopted source owns this read adapter until source retirement or reconnect. */
export function createTeamCredentialWatcherRead(input: TeamCredentialWatcherTransport & Readonly<{
  caller: ProviderBrokerWatcherOpenRequestV1['caller'];
  teamId: string;
  resourceId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  repository: TeamCredentialWatcherRepository;
  fetchImpl?: typeof fetch;
}>): Readonly<{ adapter: PluginHttpRuntimeAdapter; dispose(): Promise<void> }> {
  const lifetime = new AbortController();
  const runtime = createFetchPluginHttpRuntime(input.fetchImpl ?? ((request, options) => globalThis.fetch(request, options)));
  const initiatorMachineId = input.caller.materialization.machineId;
  const repositoryPaths = [
    `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}`.toLowerCase(),
    `/repositories/${encodeURIComponent(input.repository.repositoryId)}`,
  ];
  let admitted: Promise<OpenedWatcherBroker> | undefined;
  let opened: Promise<Readonly<{ authority: string; tunnel: ProviderBrokerMachineCarrierTunnel }>> | undefined;

  const open = async () => {
    admitted ??= (async () => {
      const request = ProviderBrokerWatcherOpenRequestV1Schema.parse({
        v: 1, scope: 'automation_event_watcher', resourceId: input.resourceId, initiatorMachineId, caller: input.caller,
      });
      const result = await input.openBroker(request, lifetime.signal);
      if (!result.ok) throw new PluginError({ code: result.reasonCode, message: 'The Team watcher credential is unavailable' });
      const { payload } = result.authority;
      if (payload.teamId !== input.teamId || payload.resourceId !== input.resourceId
        || payload.initiator.machineId !== initiatorMachineId || payload.consumer.occurrenceId !== input.caller.occurrenceId
        || !sameStrictJsonValue(payload.consumer.purpose, input.purpose)) {
        throw new PluginError({ code: 'broker_binding_changed', message: 'The broker authority does not match this watcher' });
      }
      return result;
    })().catch(error => { admitted = undefined; throw error; });
    const brokerOpen = await admitted;
    lifetime.signal.throwIfAborted();
    const tunnel = await input.openTunnel({ brokerOpen, signal: lifetime.signal });
    return { tunnel, authority: encodeProviderBrokerAuthorityV1(brokerOpen.authority) };
  };

  const adapter: PluginHttpRuntimeAdapter = {
    async request(request, options = {}) {
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      if ((request.method ?? 'GET') !== 'GET' || request.body !== undefined || url.origin !== 'https://api.github.com'
        || url.username || url.password || url.hash || !repositoryPaths.some(root => path === root || path.startsWith(`${root}/`))) {
        throw new PluginError({ code: 'broker_binding_changed', message: 'The requested read does not match this watcher’s repository' });
      }
      const headers = new Headers(request.headers);
      if (headers.has('authorization') || headers.has(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER)) {
        throw new PluginError({ code: 'broker_binding_changed', message: 'The watcher HTTP adapter owns carrier credentials' });
      }
      opened ??= open().catch(error => { opened = undefined; throw error; });
      const { authority, tunnel } = await raceWithAbort(opened, signal);
      headers.set('authorization', `Bearer ${authority}`);
      headers.set(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, tunnel.localCapability);
      const response = await runtime.request({
        url: `http://127.0.0.1:${tunnel.localPort}/v1${url.pathname}${url.search}`,
        method: 'GET', redirect: 'error', headers: Object.fromEntries(headers),
        ...(request.responseBody ? { responseBody: request.responseBody } : {}),
      }, { signal });
      return { ...response, finalUrl: request.url };
    },
    openWebSocket: runtime.openWebSocket,
  };

  return Object.freeze({ adapter, async dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    const current = await opened?.catch(() => undefined);
    await current?.tunnel.close();
  } });
}
