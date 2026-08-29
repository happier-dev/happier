import {
    PluginHostedWebAccountDataBridgeChangeV1Schema,
    PluginHostedWebAccountDataBridgeOperationV1Schema,
    PluginHostedWebAccountDataBridgeResponseV1Schema,
    type PluginHostedWebAccountDataBridgeChangeV1,
    type PluginHostedWebAccountDataBridgeOperationV1,
    type PluginHostedWebAccountDataBridgeResponseV1,
} from '@happier-dev/protocol';
import type {
    PluginUiAccountCollectionForDefinition,
    PluginUiCollectionQueryPager,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import { PluginError, isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { AccountKvTransaction } from '@happier-dev/plugin-sdk/storage';

type ActiveHostedWebAccountData = {
    readonly queryId: string;
    readonly pager: PluginUiCollectionQueryPager;
    readonly unsubscribe: () => void;
    pendingHostOperationCount: number;
};

type ActiveHostedWebAccountKvTransaction = Readonly<{
    transaction: AccountKvTransaction;
    complete(): void;
    abort(error: Error): void;
    execution: Promise<unknown>;
}>;

export type HostedWebAccountDataBridge = Readonly<{
    handle(
        operation: PluginHostedWebAccountDataBridgeOperationV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginHostedWebAccountDataBridgeResponseV1>;
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
 * hosted vocabulary. It delegates generic Collection, Account KV, and UI-query
 * operations to that client. It owns no encryption,
 * CAS, identity, limits, admission, Account lifetime, server authority, or
 * AccountChange decision; the direct client and pager remain authoritative.
 */
export function createHostedWebAccountDataBridge(input: Readonly<{
    dataClient: PluginUiDataClient;
    publish(change: PluginHostedWebAccountDataBridgeChangeV1): void;
}>): HostedWebAccountDataBridge {
    let nextQueryId = 0;
    let nextTransactionId = 0;
    let disposed = false;
    const activeQueries = new Map<string, ActiveHostedWebAccountData>();
    const activeTransactions = new Map<string, ActiveHostedWebAccountKvTransaction>();

    const createQueryId = (): string => {
        nextQueryId += 1;
        return `query_${nextQueryId}`;
    };
    const createTransactionId = (): string => {
        nextTransactionId += 1;
        return `transaction_${nextTransactionId}`;
    };
    const response = (value: unknown): PluginHostedWebAccountDataBridgeResponseV1 => (
        PluginHostedWebAccountDataBridgeResponseV1Schema.parse(value)
    );
    const close = (queryId: string): PluginHostedWebAccountDataBridgeResponseV1 => {
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
        input.publish(PluginHostedWebAccountDataBridgeChangeV1Schema.parse({
            kind: 'change',
            queryId,
        }));
    };
    const snapshotResponse = (queryId: string, pager: PluginUiCollectionQueryPager) => response({
        kind: 'snapshot',
        queryId,
        snapshot: pager.getSnapshot(),
    });
    const unavailableResponse = (queryId: string): PluginHostedWebAccountDataBridgeResponseV1 => response({
        kind: 'snapshot',
        queryId,
        snapshot: { status: 'unavailable', rows: [], hasMore: false },
    });
    const errorResponse = (queryId: string): PluginHostedWebAccountDataBridgeResponseV1 => response({
        kind: 'snapshot',
        queryId,
        snapshot: { status: 'error', rows: [], hasMore: false },
    });
    const dataResponse = (value: JsonValue): PluginHostedWebAccountDataBridgeResponseV1 => response({
        kind: 'data',
        value,
    });
    const dataErrorResponse = (error: unknown): PluginHostedWebAccountDataBridgeResponseV1 => {
        if (isPluginError(error)) {
            return response({
                kind: 'error',
                error: {
                    code: error.code,
                    message: error.message,
                    ...(error.retryable ? { retryable: true } : {}),
                    ...(error.details === undefined ? {} : { details: error.details }),
                },
            });
        }
        return response({
            kind: 'error',
            error: {
                code: 'plugin_collection_protocol_invalid',
                message: 'Hosted Account Data operation failed.',
            },
        });
    };
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
        operation: Extract<PluginHostedWebAccountDataBridgeOperationV1, { kind: 'open' }>,
        signal: AbortSignal | undefined,
    ): Promise<PluginHostedWebAccountDataBridgeResponseV1> => {
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
            let active: ActiveHostedWebAccountData | null = null;
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
    ): Promise<PluginHostedWebAccountDataBridgeResponseV1> => {
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

    const handleData = async (
        operation: Extract<PluginHostedWebAccountDataBridgeOperationV1, { kind: 'data' }>,
        signal: AbortSignal | undefined,
    ): Promise<PluginHostedWebAccountDataBridgeResponseV1> => {
        if (disposed || signal?.aborted) {
            return dataErrorResponse(new PluginError({
                code: 'plugin_account_storage_unavailable',
                message: 'Hosted Account Data bridge is unavailable.',
            }));
        }
        const args = operation.arguments;
        const signalOptions = signal === undefined ? undefined : { signal };
        try {
            let value: JsonValue = null;
            if (operation.operation === 'accountKv.transaction.begin') {
                const transactionId = createTransactionId();
                let transaction: AccountKvTransaction | null = null;
                let markStarted!: () => void;
                const started = new Promise<void>((resolve) => { markStarted = resolve; });
                let complete!: () => void;
                let abort!: (error: Error) => void;
                const completion = new Promise<void>((resolve, reject) => {
                    complete = resolve;
                    abort = reject;
                });
                const execution = input.dataClient.accountKv.transaction(async (active) => {
                    transaction = active;
                    markStarted();
                    await completion;
                    return null;
                }, signalOptions).finally(markStarted);
                void execution.catch(() => undefined);
                await started;
                if (!transaction) await execution;
                if (disposed || signal?.aborted) {
                    const retirement = new PluginError({
                        code: 'plugin_account_storage_unavailable',
                        message: 'Hosted Account Data bridge is unavailable.',
                    });
                    abort(retirement);
                    await execution.catch(() => undefined);
                    throw retirement;
                }
                const active = Object.freeze({
                    transaction: transaction!,
                    complete,
                    abort,
                    execution,
                });
                activeTransactions.set(transactionId, active);
                value = transactionId;
            } else if (operation.operation.startsWith('accountKv.transaction.')) {
                const transactionId = args[0] as string;
                const active = activeTransactions.get(transactionId);
                if (!active) {
                    throw new PluginError({
                        code: 'plugin_account_kv_invalid',
                        message: 'Hosted Account KV transaction is not active.',
                    });
                }
                switch (operation.operation) {
                    case 'accountKv.transaction.get':
                        value = await active.transaction.get(args[1] as string) as unknown as JsonValue;
                        break;
                    case 'accountKv.transaction.set': {
                        const input = args[2] as Readonly<{ value: JsonValue; expectedVersion: number | 'absent' }>;
                        value = await active.transaction.set(args[1] as string, input.value, {
                            expectedVersion: input.expectedVersion,
                        }) as unknown as JsonValue;
                        break;
                    }
                    case 'accountKv.transaction.delete': {
                        const input = args[2] as Readonly<{ expectedVersion: number }>;
                        value = await active.transaction.delete(args[1] as string, {
                            expectedVersion: input.expectedVersion,
                        }) as unknown as JsonValue;
                        break;
                    }
                    case 'accountKv.transaction.commit':
                        active.complete();
                        try {
                            await active.execution;
                        } finally {
                            activeTransactions.delete(transactionId);
                        }
                        value = null;
                        break;
                    case 'accountKv.transaction.rollback':
                        active.abort(new PluginError({
                            code: 'plugin_account_kv_invalid',
                            message: 'Hosted Account KV transaction was rolled back.',
                        }));
                        try {
                            await active.execution.catch(() => undefined);
                        } finally {
                            activeTransactions.delete(transactionId);
                        }
                        value = null;
                        break;
                }
            } else if (operation.operation.startsWith('collection.')) {
                if (!operation.definition) {
                    throw new Error('Collection definition is required.');
                }
                const collection = input.dataClient.collection(
                    operation.definition as unknown as PluginAccountCollectionDefinition,
                ) as PluginUiAccountCollectionForDefinition<PluginAccountCollectionDefinition>;
                switch (operation.operation) {
                    case 'collection.identityTag':
                        value = await collection.identityTag(args[0] as never, signalOptions);
                        break;
                    case 'collection.get':
                        value = await collection.get(args[0] as string, signalOptions) as unknown as JsonValue;
                        break;
                    case 'collection.put':
                        value = await collection.put(args[0] as never, {
                            ...(args[1] as Readonly<{ expectedRevision: number | 'absent' }>),
                            ...(signal === undefined ? {} : { signal }),
                        }) as unknown as JsonValue;
                        break;
                    case 'collection.delete':
                        value = await collection.delete(args[0] as string, {
                            ...(args[1] as Readonly<{ expectedRevision: number }>),
                            ...(signal === undefined ? {} : { signal }),
                        }) as unknown as JsonValue;
                        break;
                    case 'collection.query':
                        value = await collection.query(args[0] as never, signalOptions) as unknown as JsonValue;
                        break;
                    case 'collection.batch':
                        value = await collection.batch(args[0] as never, signalOptions) as unknown as JsonValue;
                        break;
                    case 'collection.limits':
                        value = await collection.limits(signalOptions) as unknown as JsonValue;
                        break;
                    case 'collection.measureBatch':
                        value = await collection.measureBatch(args[0] as never, signalOptions) as unknown as JsonValue;
                        break;
                }
            } else {
                switch (operation.operation) {
                    case 'accountKv.get':
                        value = await input.dataClient.accountKv.get(args[0] as string, signalOptions) as unknown as JsonValue;
                        break;
                    case 'accountKv.set':
                        value = await input.dataClient.accountKv.set(args[0] as string, args[1] as JsonValue, {
                            ...(args[2] as Readonly<{ expectedVersion: number | 'absent' }>),
                            ...(signal === undefined ? {} : { signal }),
                        }) as unknown as JsonValue;
                        break;
                    case 'accountKv.delete':
                        value = await input.dataClient.accountKv.delete(args[0] as string, {
                            ...(args[1] as Readonly<{ expectedVersion: number }>),
                            ...(signal === undefined ? {} : { signal }),
                        }) as unknown as JsonValue;
                        break;
                    case 'accountKv.list':
                        value = await input.dataClient.accountKv.list({
                            ...(args[0] as Readonly<{ cursor?: string; limit?: number; prefix?: string }>),
                            ...(signal === undefined ? {} : { signal }),
                        }) as unknown as JsonValue;
                        break;
                }
            }
            return dataResponse(value);
        } catch (error) {
            return dataErrorResponse(error);
        }
    };

    return Object.freeze({
        async handle(operation, options) {
            const parsed = PluginHostedWebAccountDataBridgeOperationV1Schema.parse(operation);
            if (disposed) {
                if (parsed.kind === 'data') return await handleData(parsed, options?.signal);
                return close(parsed.kind === 'open' ? createQueryId() : parsed.queryId);
            }
            switch (parsed.kind) {
                case 'open':
                    return await open(parsed, options?.signal);
                case 'page':
                    return await page(parsed.queryId, options?.signal);
                case 'close':
                    return close(parsed.queryId);
                case 'data':
                    return await handleData(parsed, options?.signal);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const queryId of [...activeQueries.keys()]) close(queryId);
            for (const [transactionId, transaction] of activeTransactions) {
                activeTransactions.delete(transactionId);
                transaction.abort(new PluginError({
                    code: 'plugin_account_storage_unavailable',
                    message: 'Hosted Account Data bridge retired.',
                }));
                void transaction.execution.catch(() => undefined);
            }
        },
    });
}
