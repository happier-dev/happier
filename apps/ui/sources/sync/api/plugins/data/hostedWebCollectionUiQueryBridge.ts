import {
    PluginHostedWebCollectionUiQueryBridgeChangeV1Schema,
    PluginHostedWebCollectionUiQueryBridgeOperationV1Schema,
    PluginHostedWebCollectionUiQueryBridgeResponseV1Schema,
    type PluginHostedWebCollectionUiQueryBridgeChangeV1,
    type PluginHostedWebCollectionUiQueryBridgeOperationV1,
    type PluginHostedWebCollectionUiQueryBridgeResponseV1,
} from '@happier-dev/protocol';
import type {
    PluginUiCollectionQueryPager,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';

type ActiveHostedWebCollectionUiQuery = {
    readonly queryId: string;
    readonly pager: PluginUiCollectionQueryPager;
    readonly unsubscribe: () => void;
    pendingHostOperationCount: number;
};

export type HostedWebCollectionUiQueryBridge = Readonly<{
    handle(
        operation: PluginHostedWebCollectionUiQueryBridgeOperationV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>;
    dispose(): void;
}>;

function readErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : null;
}

function isAccountUnavailable(error: unknown): boolean {
    return readErrorCode(error) === 'plugin_account_storage_unavailable';
}

/**
 * Adapts one mounted, Account-lifetime-bound Data client into the Data-owned
 * hosted query vocabulary. It does not own query cursors, Account lifetime,
 * server authority, or AccountChange: the direct pager remains authoritative.
 */
export function createHostedWebCollectionUiQueryBridge(input: Readonly<{
    dataClient: PluginUiDataClient;
    publish(change: PluginHostedWebCollectionUiQueryBridgeChangeV1): void;
}>): HostedWebCollectionUiQueryBridge {
    let nextQueryId = 0;
    let disposed = false;
    const activeQueries = new Map<string, ActiveHostedWebCollectionUiQuery>();

    const createQueryId = (): string => {
        nextQueryId += 1;
        return `query_${nextQueryId}`;
    };
    const response = (value: unknown): PluginHostedWebCollectionUiQueryBridgeResponseV1 => (
        PluginHostedWebCollectionUiQueryBridgeResponseV1Schema.parse(value)
    );
    const close = (queryId: string): PluginHostedWebCollectionUiQueryBridgeResponseV1 => {
        const active = activeQueries.get(queryId);
        if (active) {
            activeQueries.delete(queryId);
            active.unsubscribe();
            active.pager.dispose();
        }
        return response({ kind: 'closed', queryId });
    };
    const publishWakeup = (queryId: string): void => {
        if (disposed || !activeQueries.has(queryId)) return;
        input.publish(PluginHostedWebCollectionUiQueryBridgeChangeV1Schema.parse({
            kind: 'change',
            queryId,
        }));
    };
    const snapshotResponse = (queryId: string, pager: PluginUiCollectionQueryPager) => response({
        kind: 'snapshot',
        queryId,
        snapshot: pager.getSnapshot(),
    });
    const unavailableResponse = (queryId: string): PluginHostedWebCollectionUiQueryBridgeResponseV1 => response({
        kind: 'snapshot',
        queryId,
        snapshot: { status: 'unavailable', rows: [], hasMore: false },
    });
    const errorResponse = (queryId: string): PluginHostedWebCollectionUiQueryBridgeResponseV1 => response({
        kind: 'snapshot',
        queryId,
        snapshot: { status: 'error', rows: [], hasMore: false },
    });
    const withAbortClosure = async <T>(
        queryId: string,
        signal: AbortSignal | undefined,
        operation: () => Promise<T>,
    ): Promise<T | null> => {
        if (signal?.aborted) {
            close(queryId);
            return null;
        }
        const onAbort = () => { close(queryId); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            return await operation();
        } finally {
            signal?.removeEventListener('abort', onAbort);
        }
    };

    const open = async (
        operation: Extract<PluginHostedWebCollectionUiQueryBridgeOperationV1, { kind: 'open' }>,
        signal: AbortSignal | undefined,
    ): Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1> => {
        const queryId = createQueryId();
        if (disposed || signal?.aborted) return close(queryId);
        try {
            const pager = await input.dataClient.openCollectionQuery({
                collectionId: operation.collectionId,
                uiQueryId: operation.uiQueryId,
                parameters: operation.parameters,
                ...(signal === undefined ? {} : { signal }),
            });
            if (disposed || signal?.aborted) {
                pager.dispose();
                return close(queryId);
            }
            let active: ActiveHostedWebCollectionUiQuery | null = null;
            const unsubscribe = pager.subscribe(() => {
                if (!active || active.pendingHostOperationCount > 0 || !activeQueries.has(queryId)) return;
                // The direct pager reports loading before it completes its
                // Data-owned reread. One final opaque wakeup is enough for the
                // guest to reopen the static query without receiving row data.
                const snapshot = pager.getSnapshot();
                if (snapshot.status === 'loading' || snapshot.status === 'idle') return;
                publishWakeup(queryId);
            });
            active = {
                queryId,
                pager,
                unsubscribe,
                pendingHostOperationCount: 1,
            };
            activeQueries.set(queryId, active);
            const completed = await withAbortClosure(queryId, signal, async () => {
                await pager.refresh();
                return undefined;
            });
            active.pendingHostOperationCount -= 1;
            if (completed === null || disposed || !activeQueries.has(queryId)) return close(queryId);
            return snapshotResponse(queryId, pager);
        } catch (error) {
            if (signal?.aborted) return close(queryId);
            close(queryId);
            return isAccountUnavailable(error)
                ? unavailableResponse(queryId)
                : errorResponse(queryId);
        }
    };
    const page = async (
        queryId: string,
        signal: AbortSignal | undefined,
    ): Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1> => {
        const active = activeQueries.get(queryId);
        if (disposed || !active || signal?.aborted) return close(queryId);
        active.pendingHostOperationCount += 1;
        try {
            const completed = await withAbortClosure(queryId, signal, async () => {
                await active.pager.loadMore();
                return undefined;
            });
            if (completed === null || disposed || !activeQueries.has(queryId)) return close(queryId);
            return snapshotResponse(queryId, active.pager);
        } catch (error) {
            return isAccountUnavailable(error)
                ? unavailableResponse(queryId)
                : errorResponse(queryId);
        } finally {
            active.pendingHostOperationCount -= 1;
        }
    };

    return Object.freeze({
        async handle(operation, options) {
            const parsed = PluginHostedWebCollectionUiQueryBridgeOperationV1Schema.parse(operation);
            if (disposed) {
                const queryId = parsed.kind === 'open' ? createQueryId() : parsed.queryId;
                return close(queryId);
            }
            switch (parsed.kind) {
                case 'open':
                    return await open(parsed, options?.signal);
                case 'page':
                    return await page(parsed.queryId, options?.signal);
                case 'close':
                    return close(parsed.queryId);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const queryId of [...activeQueries.keys()]) close(queryId);
        },
    });
}
