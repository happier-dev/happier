import { serveActionHomes } from './actionHomesHttpHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import type { KvListResponse } from '@/sync/api/account/apiKv';

/** A signed-in Home for Session UI actions; domain logic and the Action front door remain real. */
export async function serveSessionActionHome(params: Parameters<typeof serveActionHomes>[0] = {
    homes: [{ key: 'session', serverUrl: 'https://session-actions.test', accountId: 'session-account', currentAccount: true }],
    route: () => undefined,
}) {
    const sync = await loadSyncSingletonForTests();
    try {
        const home = await serveActionHomes({ ...params, route: async request => {
            const response = await params.route(request);
            if (response) return response;
            // Session journeys keep the real reconnect/bootstrap owners. Answer their
            // current empty wire shapes instead of an obsolete /v1 fallback census.
            if (request.path === '/v2/sessions' || request.path === '/v2/sessions/active')
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            // The default fixture has no Account Tasks; other KV namespaces are not claimed.
            if (request.path === '/v1/kv' && request.method === 'GET'
                && request.url.searchParams.get('prefix') === 'todo.') return Response.json({ items: [] } satisfies KvListResponse);
            // No Machine, organization or installed-Plugin rows are admitted unless the caller serves
            // them. Reconnect still traverses their real readers and strict schemas.
            if (request.path === '/v2/session-organization' || (request.path === '/v1/machines'
                && request.url.searchParams.get('includeRevoked') === 'true')
                || request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']
                || request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']
                || request.path === '/v1/feed') {
                return createEmptyAccountBootstrapHttpResponse(request.url.pathname + request.url.search,
                    { method: request.method }) ?? undefined;
            }
            if (request.path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (request.path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            return undefined;
        } });
        return {
            ...home,
            serverId: getActiveServerSnapshot().serverId,
            async dispose() {
                try {
                    await home.dispose();
                } finally {
                    sync.dispose();
                }
            },
        };
    } catch (error) {
        sync.dispose();
        throw error;
    }
}
