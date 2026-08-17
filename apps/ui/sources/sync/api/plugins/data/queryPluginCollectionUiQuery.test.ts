import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    NormalizedPluginCollectionUiQueryDescriptorV1,
    PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol';
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
} from '@happier-dev/protocol';

const descriptor: NormalizedPluginCollectionUiQueryDescriptorV1 = {
    collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
    id: 'open',
    indexId: 'by-status',
    parameters: {
        status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
    },
    prefix: [{ kind: 'parameter', parameterId: 'status' }],
    order: 'asc',
    pageSize: 50,
    projectedFields: [
        { field: 'status', kind: 'string' },
        { field: 'title', kind: 'string' },
    ],
};

const request: PluginCollectionUiQueryRequestV1 = {
    pluginId: 'example.tasks',
    collectionId: 'tasks',
    uiQueryId: 'open',
    parameters: { status: 'open' },
};

const response = {
    rows: [{
        context: {
            collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
            rowId: 'task-1',
            revision: 3,
        },
        fields: { status: 'open', title: 'Ship the adapter' },
    }],
    changeCursor: 42,
};

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

async function loadClient(params?: Readonly<{
    retireOnRequest?: boolean;
    serverProtocolVersion?: number | null;
}>) {
    vi.resetModules();
    let current = true;
    let generation = 1;
    const retireCallbacks = new Set<() => void>();
    const transport = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () => {
        if (params?.retireOnRequest) current = false;
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (callback: () => void) => {
            retireCallbacks.add(callback);
            return {
                dispose: () => {
                    retireCallbacks.delete(callback);
                },
            };
        },
    };

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => lifetime,
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation,
        }),
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({
        apiSocket: { request: vi.fn() },
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: async () => ({
            scope: lifetime.scope,
            context: {},
            request: transport,
        }),
    }));

    const client = await import('./queryPluginCollectionUiQuery');
    if (params?.serverProtocolVersion !== null) {
        const { recordAccountStoredContentServerRequirements } = await import(
            '@/sync/http/accountStoredContentCompatibility'
        );
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: params?.serverProtocolVersion ?? 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
    }
    return {
        ...client,
        transport,
        retire: () => { current = false; },
        retireScope: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
        advanceGeneration: () => { generation += 1; },
    };
}

describe('queryActivePluginCollectionUiQuery', () => {
    it('uses one active Account-scoped authenticated request and returns only the validated projection', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request })).resolves.toEqual(response);
        const [path, init] = transport.mock.calls[0]!;
        expect(path).toBe('/v1/plugins/data/ui-query');
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify(request),
        });
        expect(new Headers(init.headers).get(
            ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
        )).toBe(String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION));
    });

    it('returns the canonical invalid-query outcome from a 400 response', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();
        transport.mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'collection_query_invalid',
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request })).resolves.toEqual({
            error: 'collection_query_invalid',
        });
    });

    it('returns the canonical unavailable-collection outcome from a 404 response', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();
        transport.mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'collection_unavailable',
        }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request })).resolves.toEqual({
            error: 'collection_unavailable',
        });
    });

    it('returns the canonical index-not-ready outcome from a 409 response', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();
        transport.mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'collection_index_not_ready',
        }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request })).resolves.toEqual({
            error: 'collection_index_not_ready',
        });
    });

    it('rejects a non-2xx body outside the canonical Protocol error union', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();
        transport.mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'unrecognized_server_error',
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request }))
            .rejects.toThrow('request failed with status 400');
    });

    it('returns typed unavailable before issuing a Data request to a V2-only server', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient({
            serverProtocolVersion: 2,
        });

        await expect(queryActivePluginCollectionUiQuery({ descriptor, request })).resolves.toEqual({
            status: 'unavailable',
            reason: 'server-protocol-too-old',
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects invalid static parameters before issuing the request', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();

        await expect(queryActivePluginCollectionUiQuery({
            descriptor,
            request: { ...request, parameters: {} },
        })).rejects.toThrow('UI query parameter "status" is required');
        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects a request outside its admitted collection before issuing it', async () => {
        const { queryActivePluginCollectionUiQuery, transport } = await loadClient();

        await expect(queryActivePluginCollectionUiQuery({
            descriptor,
            request: { ...request, collectionId: 'other-tasks' },
        })).rejects.toThrow('does not match its admitted descriptor');
        expect(transport).not.toHaveBeenCalled();
    });

    it('drops a response when its captured Account lifetime or server generation is no longer current', async () => {
        const client = await loadClient({ retireOnRequest: true });

        await expect(client.queryActivePluginCollectionUiQuery({ descriptor, request }))
            .rejects.toThrow('Active Account scope changed');

        const staleGeneration = await loadClient();
        staleGeneration.transport.mockImplementationOnce(async () => {
            staleGeneration.advanceGeneration();
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        await expect(staleGeneration.queryActivePluginCollectionUiQuery({ descriptor, request }))
            .rejects.toThrow('Active server generation changed');
    });

    it('coalesces matching content-free AccountChange invalidations and retires with the Account scope', async () => {
        const client = await loadClient();
        const onInvalidated = vi.fn();
        const watch = client.watchActivePluginCollectionUiQuery({ descriptor, request, onInvalidated });

        client.publishActivePluginCollectionUiQueryChanges([
            {
                cursor: 10,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 10,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    contractDigest: 'a'.repeat(43),
                    revision: 1,
                    rowIds: ['task-1'],
                },
            },
            {
                cursor: 11,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 11,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    contractDigest: 'a'.repeat(43),
                    revision: 2,
                    full: true,
                },
            },
            {
                cursor: 12,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/projects',
                changedAt: 12,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'projects',
                    contractDigest: 'a'.repeat(43),
                    revision: 1,
                    full: true,
                },
            },
        ]);

        expect(onInvalidated).toHaveBeenCalledTimes(1);

        client.resetActivePluginCollectionUiQueryWatches();
        expect(onInvalidated).toHaveBeenCalledTimes(2);

        client.retireScope();
        client.publishActivePluginCollectionUiQueryChanges([
            {
                cursor: 13,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 13,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    contractDigest: 'a'.repeat(43),
                    revision: 3,
                    full: true,
                },
            },
        ]);
        expect(onInvalidated).toHaveBeenCalledTimes(2);

        watch.dispose();
    });

    it('keeps opaque cursor advancement inside the Data pager and exposes only one bounded page snapshot', async () => {
        const client = await loadClient();
        const firstPage = {
            ...response,
            nextCursor: 'next_page',
        };
        const secondPage = {
            ...response,
            rows: [{
                ...response.rows[0]!,
                context: { ...response.rows[0]!.context, rowId: 'task-2', revision: 4 },
            }],
            changeCursor: 43,
        };
        client.transport
            .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        const pager = client.createActivePluginCollectionUiQueryPager({
            descriptor,
            request,
        });

        await pager.refresh();
        expect(pager.getSnapshot()).toEqual({
            status: 'ready',
            rows: firstPage.rows,
            hasMore: true,
        });
        expect(pager.getSnapshot()).not.toHaveProperty('nextCursor');

        await pager.loadMore();
        expect(JSON.parse(String(client.transport.mock.calls[1]?.[1]?.body))).toEqual({
            ...request,
            cursor: 'next_page',
        });
        expect(pager.getSnapshot()).toEqual({
            status: 'ready',
            rows: secondPage.rows,
            hasMore: false,
        });
        pager.dispose();
    });

    it('retains a canonical query error as the pager error outcome', async () => {
        const client = await loadClient();
        client.transport.mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'collection_index_not_ready',
        }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        const pager = client.createActivePluginCollectionUiQueryPager({ descriptor, request });

        await pager.refresh();

        expect(pager.getSnapshot()).toEqual({
            status: 'error',
            rows: [],
            hasMore: false,
            error: { error: 'collection_index_not_ready' },
        });
        pager.dispose();
    });

    it('serializes a refresh requested synchronously by a snapshot subscriber', async () => {
        const client = await loadClient();
        const pendingResponses: Array<(response: Response) => void> = [];
        client.transport.mockImplementation(() => new Promise<Response>((resolve) => {
            pendingResponses.push(resolve);
        }));
        const pager = client.createActivePluginCollectionUiQueryPager({ descriptor, request });
        let requestedRefresh = false;
        let subscriberRefresh: Promise<void> | undefined;
        const unsubscribe = pager.subscribe(() => {
            if (!requestedRefresh && pager.getSnapshot().status === 'loading') {
                requestedRefresh = true;
                subscriberRefresh = pager.refresh();
            }
        });

        const initialRefresh = pager.refresh();
        await vi.waitFor(() => expect(client.transport).toHaveBeenCalledTimes(1));

        // The subscriber's refresh is queued behind this read. It must not
        // create a second active authenticated request while notification is
        // still unwinding.
        expect(client.transport).toHaveBeenCalledTimes(1);
        const first = pendingResponses.shift();
        if (!first) throw new Error('expected the first query response to be pending');
        first(new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await vi.waitFor(() => expect(client.transport).toHaveBeenCalledTimes(2));
        const second = pendingResponses.shift();
        if (!second) throw new Error('expected the queued query response to be pending');
        second(new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await initialRefresh;
        await subscriberRefresh;
        expect(pager.getSnapshot()).toMatchObject({ status: 'ready', rows: response.rows });
        unsubscribe();
        pager.dispose();
    });

    it('resets an in-flight opaque continuation after a matching AccountChange and rejects its late page', async () => {
        const client = await loadClient();
        const firstPage = {
            ...response,
            nextCursor: 'opaque-page-2',
        };
        const staleContinuation = {
            ...response,
            rows: [{
                ...response.rows[0]!,
                context: { ...response.rows[0]!.context, rowId: 'stale-page-2', revision: 4 },
            }],
        };
        const refreshedPage = {
            ...response,
            rows: [{
                ...response.rows[0]!,
                context: { ...response.rows[0]!.context, rowId: 'fresh-page-1', revision: 5 },
            }],
        };
        let resolveStaleContinuation!: (value: Response) => void;
        const staleContinuationPromise = new Promise<Response>((resolve) => {
            resolveStaleContinuation = resolve;
        });
        client.transport
            .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockImplementationOnce(() => staleContinuationPromise)
            .mockResolvedValueOnce(new Response(JSON.stringify(refreshedPage), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        const pager = client.createActivePluginCollectionUiQueryPager({ descriptor, request });
        const publishedRowIds: string[][] = [];
        const unsubscribe = pager.subscribe(() => {
            publishedRowIds.push(pager.getSnapshot().rows.map((row) => row.context.rowId));
        });

        await pager.refresh();
        const continuation = pager.loadMore();
        await vi.waitFor(() => expect(client.transport).toHaveBeenCalledTimes(2));
        expect(JSON.parse(String(client.transport.mock.calls[1]?.[1]?.body))).toEqual({
            ...request,
            cursor: 'opaque-page-2',
        });

        client.publishActivePluginCollectionUiQueryChanges([{
            cursor: 10,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.tasks/data-collection/tasks',
            changedAt: 10,
            hint: {
                pluginDomain: 'dataCollection',
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: 'a'.repeat(43),
                revision: 2,
                full: true,
            },
        }]);
        resolveStaleContinuation(new Response(JSON.stringify(staleContinuation), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await continuation;

        expect(client.transport).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(client.transport.mock.calls[2]?.[1]?.body))).toEqual(request);
        expect(pager.getSnapshot()).toEqual({
            status: 'ready',
            rows: refreshedPage.rows,
            hasMore: false,
        });
        expect(publishedRowIds.flat()).not.toContain('stale-page-2');
        unsubscribe();
        pager.dispose();
    });

    it('retires a blocked Account A pager without stale publication or queued reread, while a new Account pager remains usable', async () => {
        const client = await loadClient();
        const pendingResponses: Array<(response: Response) => void> = [];
        client.transport.mockImplementation(() => new Promise<Response>((resolve) => {
            pendingResponses.push(resolve);
        }));
        const pager = client.createActivePluginCollectionUiQueryPager({ descriptor, request });
        const onSnapshot = vi.fn();
        const unsubscribe = pager.subscribe(onSnapshot);

        const refresh = pager.refresh();
        await vi.waitFor(() => expect(client.transport).toHaveBeenCalledTimes(1));
        client.publishActivePluginCollectionUiQueryChanges([{
            cursor: 10,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.tasks/data-collection/tasks',
            changedAt: 10,
            hint: {
                pluginDomain: 'dataCollection',
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: 'a'.repeat(43),
                revision: 1,
                full: true,
            },
        }]);
        client.retireScope();
        onSnapshot.mockClear();
        const first = pendingResponses.shift();
        if (!first) throw new Error('Account A query was not pending.');
        first(new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await refresh;

        expect(onSnapshot).not.toHaveBeenCalled();
        expect(client.transport).toHaveBeenCalledTimes(1);
        unsubscribe();

        const accountB = await loadClient();
        const accountBPager = accountB.createActivePluginCollectionUiQueryPager({ descriptor, request });
        await expect(accountBPager.refresh()).resolves.toBeUndefined();
        expect(accountBPager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: response.rows,
        });
        accountBPager.dispose();
    });

    it('drops Account A last-known rows synchronously when its scope retires', async () => {
        const client = await loadClient();
        const pager = client.createActivePluginCollectionUiQueryPager({ descriptor, request });

        await pager.refresh();
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: response.rows,
        });

        client.retireScope();

        expect(pager.getSnapshot()).toEqual({
            status: 'idle',
            rows: [],
            hasMore: false,
        });
        await expect(pager.refresh()).resolves.toBeUndefined();
        expect(client.transport).toHaveBeenCalledTimes(1);
        pager.dispose();
    });
});
