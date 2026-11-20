import { GITHUB_BROKER_WATCHER_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { isPluginHttpCredentialHeader } from '@happier-dev/cli-common/plugins/http';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { createPluginHttpService, type PluginHttpRuntimeAdapter } from '@/plugins/runtime/fetch/service';
import type { startDaemonProviderBrokerRuntime } from './daemonProviderBrokerRuntime';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const WATCHER_REQUEST_HEADERS = new Set(['accept', 'if-none-match', 'user-agent', 'x-github-api-version']);
const GITHUB_WATCHER_READ_PATH = /^\/repos\/[a-z\d][a-z\d-]*\/(?!\.{1,2}(?:\/|$))[a-z\d_.-]+(?:\/events|\/actions\/runs(?:\/[1-9]\d*(?:\/pending_deployments)?)?)?$/i;
// GitHub may return this alternate collection URL in a pagination link. The
// watcher validates the immutable repository ID before forwarding that page.
const GITHUB_WATCHER_PAGE_PATH = /^\/repositories\/[1-9]\d*\/actions\/runs$/;

type WatcherRead = NonNullable<Parameters<typeof startDaemonProviderBrokerRuntime>[0]['watcherReads']>;

/** Spends an already Home-admitted watcher grant at the custodian's HTTP boundary. */
export function createTeamCredentialBrokerWatcherRead(input: Readonly<{
  purposeBindings: Pick<DaemonConnectedAccountPurposeBindingRuntime, 'owner' | 'resolveBindingIntentSelection' | 'activatePurposeBindings'>;
  httpAdapter?: PluginHttpRuntimeAdapter;
}>): WatcherRead {
  const http = createPluginHttpService({ adapter: input.httpAdapter ?? createGlobalFetchRuntime() });
  return async ({ authority, requestId, request }) => {
    // The sender owns exact repository admission under its decrypted Event
    // definition. The carrier can spend the grant only on these watcher reads.
    const checksPost = request.method === 'POST' && request.pathAndQuery === '/v1/graphql';
    const get = request.method === 'GET' && request.body === undefined && request.pathAndQuery.startsWith('/v1/');
    if (!checksPost && !get) {
      return { ok: false, reasonCode: 'route_not_allowed' };
    }
    const url = new URL(GITHUB_API_ORIGIN + request.pathAndQuery.slice('/v1'.length));
    const checks = checksPost
      ? (await import('@happier-dev/plugins-scm-github/checks-watcher')).readGithubWatcherChecksQuery(request.body)
      : null;
    if (checksPost ? checks === null
      : !GITHUB_WATCHER_READ_PATH.test(url.pathname) && !GITHUB_WATCHER_PAGE_PATH.test(url.pathname)) {
      return { ok: false, reasonCode: 'route_not_allowed' };
    }
    const { source, consumer } = authority.payload;
    if (source.kind === 'provider_connection') return { ok: false, reasonCode: 'resource_unavailable' };
    const github = GITHUB_BROKER_WATCHER_V1;
    const service = source.target.kind === 'account' ? source.target.account.service : source.target.service;
    const purpose = consumer.purpose;
    if (service.pluginId !== github.service.pluginId || service.localId !== github.service.localId
      || purpose.consumer.pluginId !== github.service.pluginId || purpose.consumer.localId !== github.attemptActionId
      || purpose.purpose !== github.purposeId) {
      return { ok: false, reasonCode: 'resource_unavailable' };
    }
    const signal = request.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    // Home already decided Team entitlement, placement and the persisted
    // source incarnation at activation. Existing Connected Account selection
    // and materialization own secret acquisition (and any needed refresh).
    const serviceRefs = [service];
    const selection = await input.purposeBindings.resolveBindingIntentSelection({
      purpose, target: source.target, serviceRefs, signal,
    });
    if (source.kind === 'connected_pool' && selection.resolved.observation?.group?.incarnation !== source.poolIncarnation) {
      return { ok: false, reasonCode: 'resource_unavailable' };
    }
    signal.throwIfAborted();
    const binding = input.purposeBindings.activatePurposeBindings({
      subject: { kind: 'operation', operationId: requestId, consumer: purpose.consumer, isCurrent: () => !signal.aborted },
      purposes: [purpose], bindings: [selection.binding], bindingSelections: [selection],
    });
    try {
      const material = await input.purposeBindings.owner.materialize({
        exactPurposeBindingSubjectId: binding.subjectId, purpose, serviceRefs, signal,
        request: { kind: 'httpHeaders', origin: GITHUB_API_ORIGIN, headerNames: ['authorization'] },
      });
      const authorization = material.kind === 'httpHeaders'
        ? Object.entries(material.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] : undefined;
      if (!authorization) return { ok: false, reasonCode: 'resource_unavailable' };
      signal.throwIfAborted();
      const publicHeaders = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => WATCHER_REQUEST_HEADERS.has(name)));
      const response = await http.request({
        url: url.href, method: checks ? 'POST' : 'GET', redirect: 'error',
        headers: { 'user-agent': github.service.pluginId, ...publicHeaders,
          ...(checks ? { 'content-type': 'application/json' } : {}), authorization },
        ...(checks ? { body: checks.body } : {}),
      }, { signal });
      const headers = Object.fromEntries(Object.entries(response.headers)
        .filter(([name]) => !isPluginHttpCredentialHeader(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie'));
      return { ok: true, response: {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: '',
        headers,
        body: response.body.byteLength === 0 ? null : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(response.body);
            controller.close();
          },
        }),
      } };
    } finally {
      binding.dispose();
    }
  };
}
