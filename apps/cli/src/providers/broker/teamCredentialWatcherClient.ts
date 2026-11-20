import { createFetchPluginHttpRuntime, raceWithAbort } from '@happier-dev/cli-common/plugins/http';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS, type QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerWatcherOpenRequestV1,
  type ProviderBrokerWatcherOpenResponseV1,
  type ProviderBrokerWatcherRefreshRequestV1,
  type ProviderBrokerWatcherRefreshResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import type { ProviderBrokerMachineCarrierTunnel } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { providerBrokerRouteGrantExpectedBindingV1 } from '@/daemon/peer/mediation/verifyProviderBrokerRouteGrantV1';
import type { PluginHttpRuntimeAdapter } from '@/plugins/runtime/fetch/service';

type OpenedWatcherBroker = Extract<ProviderBrokerWatcherOpenResponseV1, { ok: true }>;
type WatcherAdmission = Readonly<{ brokerOpen: OpenedWatcherBroker; authorization: string }>;

export type TeamCredentialWatcherTransport = Readonly<{
  openBroker(request: ProviderBrokerWatcherOpenRequestV1 | ProviderBrokerWatcherRefreshRequestV1, signal: AbortSignal): Promise<ProviderBrokerWatcherOpenResponseV1 | ProviderBrokerWatcherRefreshResponseV1>;
  openTunnel(request: Readonly<{
    brokerOpen: OpenedWatcherBroker;
    refreshBrokerOpen(): Promise<OpenedWatcherBroker>;
    signal: AbortSignal;
  }>): Promise<ProviderBrokerMachineCarrierTunnel>;
}>;

export type TeamCredentialWatcherRepository = Readonly<{ owner: string; name: string; repositoryId: string }>;

/** The adopted source owns this read adapter until source retirement or reconnect. */
export function createTeamCredentialWatcherRead(input: TeamCredentialWatcherTransport & Readonly<{
  caller: ProviderBrokerWatcherOpenRequestV1['caller'];
  activation: ProviderBrokerWatcherRefreshRequestV1['activation'];
  teamId: string;
  resourceId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  repository: TeamCredentialWatcherRepository;
  checks?: Readonly<{ eventLocalId: string; pullRequestNumber: number }>;
  fetchImpl?: typeof fetch;
}>): Readonly<{ adapter: PluginHttpRuntimeAdapter; dispose(): Promise<void> }> {
  const lifetime = new AbortController();
  const runtime = createFetchPluginHttpRuntime(input.fetchImpl ?? ((request, options) => globalThis.fetch(request, options)));
  const initiatorMachineId = input.caller.materialization.machineId;
  const repositoryPaths = [
    `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}`.toLowerCase(),
    `/repositories/${encodeURIComponent(input.repository.repositoryId)}`,
  ];
  let admitted: Promise<WatcherAdmission> | undefined;
  let opened: Promise<ProviderBrokerMachineCarrierTunnel> | undefined;

  const requestAuthority = async (previous?: OpenedWatcherBroker): Promise<WatcherAdmission> => {
    const request: ProviderBrokerWatcherOpenRequestV1 | ProviderBrokerWatcherRefreshRequestV1 = {
      v: 1, scope: 'automation_event_watcher', resourceId: input.resourceId, initiatorMachineId, caller: input.caller, activation: input.activation,
      ...(previous ? { refreshAuthority: previous.authority } : {}),
    };
    const result = await input.openBroker(request, lifetime.signal).catch(() => {
      lifetime.signal.throwIfAborted();
      throw new PluginError({ code: 'broker_unavailable', message: 'The Team watcher credential is unavailable' });
    });
    lifetime.signal.throwIfAborted();
    if (!result.ok) throw new PluginError({ code: result.reasonCode, message: 'The Team watcher credential is unavailable' });
    const { authority } = result;
    const { payload } = authority;
    if (!payload.activationBinding || payload.teamId !== input.teamId || payload.resourceId !== input.resourceId
        || payload.initiator.machineId !== initiatorMachineId || payload.consumer.occurrenceId !== input.caller.occurrenceId
        || !sameStrictJsonValue(payload.consumer.purpose, input.purpose)
        || (previous && !sameStrictJsonValue(providerBrokerRouteGrantExpectedBindingV1(authority),
          providerBrokerRouteGrantExpectedBindingV1(previous.authority)))) {
      throw new PluginError({ code: 'broker_binding_changed', message: 'The broker authority does not match this watcher' });
    }
    const target = previous?.target ?? ('target' in result ? result.target : undefined);
    if (!target) throw new PluginError({ code: 'broker_unavailable', message: 'The watcher authority is missing its Machine carrier' });
    return { brokerOpen: { ok: true, authority, target }, authorization: `Bearer ${encodeProviderBrokerAuthorityV1(authority)}` };
  };

  const readAuthority = async (): Promise<WatcherAdmission> => {
    lifetime.signal.throwIfAborted();
    if (!admitted) {
      admitted = requestAuthority().catch(error => { admitted = undefined; throw error; });
      return admitted;
    }
    const pending = admitted;
    const current = await pending;
    lifetime.signal.throwIfAborted();
    if (Date.now() + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS < current.brokerOpen.authority.payload.expiresAt) return current;
    // Concurrent reads and new streams join the same lazy refresh. A failed
    // renewal retains only the original witness for the next authorized attempt.
    if (admitted === pending) {
      admitted = requestAuthority(current.brokerOpen).catch(error => { admitted = pending; throw error; });
    }
    return admitted;
  };

  const adapter: PluginHttpRuntimeAdapter = {
    async request(request, options = {}) {
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      const githubOrigin = url.origin === 'https://api.github.com' && !url.username && !url.password && !url.hash;
      const repositoryGet = githubOrigin && (request.method ?? 'GET') === 'GET' && request.body === undefined
        && repositoryPaths.some(root => path === root || path.startsWith(`${root}/`));
      let checksBody: Uint8Array | undefined;
      if (githubOrigin && request.method === 'POST' && url.pathname === '/graphql' && !url.search && input.checks) {
        const { isGithubChecksEvent, readGithubWatcherChecksQuery } = await import('@happier-dev/plugins-scm-github/checks-watcher');
        const checks = readGithubWatcherChecksQuery(request.body);
        if (checks && isGithubChecksEvent(input.checks.eventLocalId)
          && checks.pullRequestNumber === input.checks.pullRequestNumber
          && checks.owner.toLowerCase() === input.repository.owner.toLowerCase()
          && checks.name.toLowerCase() === input.repository.name.toLowerCase()) {
          checksBody = checks.body;
        }
      }
      if (!repositoryGet && !checksBody) {
        throw new PluginError({ code: 'broker_binding_changed', message: 'The requested read does not match this watcher’s repository' });
      }
      const headers = new Headers(request.headers);
      if (headers.has('authorization') || headers.has(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER)) {
        throw new PluginError({ code: 'broker_binding_changed', message: 'The watcher HTTP adapter owns carrier credentials' });
      }
      const { brokerOpen, authorization } = await raceWithAbort(readAuthority(), signal);
      signal.throwIfAborted();
      opened ??= input.openTunnel({ brokerOpen, refreshBrokerOpen: async () => (await readAuthority()).brokerOpen,
        signal: lifetime.signal }).catch(error => { opened = undefined; throw error; });
      const tunnel = await raceWithAbort(opened, signal);
      headers.set('authorization', authorization);
      headers.set(MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, tunnel.localCapability);
      if (checksBody) headers.set('content-type', 'application/json');
      const response = await runtime.request({
        url: `http://127.0.0.1:${tunnel.localPort}/v1${url.pathname}${url.search}`,
        method: checksBody ? 'POST' : 'GET', redirect: 'error', headers: Object.fromEntries(headers),
        ...(checksBody ? { body: checksBody } : {}),
        ...(request.responseBody ? { responseBody: request.responseBody } : {}),
      }, { signal });
      return { ...response, finalUrl: request.url };
    },
    openWebSocket: runtime.openWebSocket,
  };

  return Object.freeze({ adapter, async dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    const tunnel = await opened?.catch(() => undefined);
    await tunnel?.close();
  } });
}
