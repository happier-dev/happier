import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc';
import type { z } from 'zod';

import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { mutateProviderConnection, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

type ProviderConnectionMutationResult = Awaited<ReturnType<typeof mutateProviderConnection>> | null;
type ProviderConnectionMutationScope = Readonly<{
    serverId: string | null;
    refresh: () => Promise<void>;
    revision: number;
}>;
type PendingMutationState = Readonly<{
    scope: ProviderConnectionMutationScope;
    countByKey: ReadonlyMap<string, number>;
}>;

export function useProviderConnectionMutation(input: Readonly<{
    serverId: string | null;
    refresh: () => Promise<void>;
}>) {
    const [failure, setFailure] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
    }> | null>(null);
    const activeScope = React.useRef<ProviderConnectionMutationScope>({
        serverId: input.serverId,
        refresh: input.refresh,
        revision: 0,
    });
    const [pending, setPending] = React.useState<PendingMutationState>(() => ({
        scope: activeScope.current,
        countByKey: new Map(),
    }));
    const inFlightByRequestKey = React.useRef(new Map<string, Readonly<{
        promise: Promise<ProviderConnectionMutationResult> | null;
    }>>());
    if (activeScope.current.serverId !== input.serverId || activeScope.current.refresh !== input.refresh) {
        activeScope.current = {
            serverId: input.serverId,
            refresh: input.refresh,
            revision: activeScope.current.revision + 1,
        };
    }
    React.useEffect(() => {
        const scope = activeScope.current;
        setPending((current) => current.scope === scope
            ? current
            : { scope, countByKey: new Map() });
        setFailure(null);
    }, [input.refresh, input.serverId]);
    const updatePending = React.useCallback((
        scope: ProviderConnectionMutationScope,
        key: string,
        delta: 1 | -1,
    ) => {
        setPending((current) => {
            if (activeScope.current !== scope) return current;
            const countByKey = current.scope === scope ? current.countByKey : new Map<string, number>();
            const count = countByKey.get(key) ?? 0;
            const nextCount = count + delta;
            if (nextCount === count && current.scope === scope) return current;
            const nextCountByKey = new Map(countByKey);
            if (nextCount > 0) {
                nextCountByKey.set(key, nextCount);
            } else {
                nextCountByKey.delete(key);
            }
            return { scope, countByKey: nextCountByKey };
        });
    }, []);
    const run = React.useCallback((
        request: z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>,
        key = `${request.action}:${request.connectionId}`,
    ): Promise<ProviderConnectionMutationResult> => {
        const scope = activeScope.current;
        let parsedRequest: z.output<typeof DaemonProviderConnectionMutationRequestV1Schema>;
        try {
            parsedRequest = DaemonProviderConnectionMutationRequestV1Schema.parse(request);
        } catch (caught) {
            if (activeScope.current === scope) {
                const nextError = providerErrorFromRpcFailure(caught, {
                    machineId: request.machineId,
                    ...('connectionId' in request && request.connectionId
                        ? { connectionId: request.connectionId }
                        : {}),
                });
                setFailure({
                    error: nextError,
                    ...providerRetryRecoveryForError(nextError, async () => {
                        await run(request, key);
                    }),
                });
            }
            return Promise.resolve(null);
        }
        const requestKey = stableJsonStringify([scope.revision, key, parsedRequest]);
        const existing = inFlightByRequestKey.current.get(requestKey);
        if (existing?.promise) return existing.promise;
        const isCurrentScope = () => activeScope.current === scope;
        const errorContext = {
            machineId: parsedRequest.machineId,
            ...('connectionId' in parsedRequest ? { connectionId: parsedRequest.connectionId } : {}),
        };
        const operation: { promise: Promise<ProviderConnectionMutationResult> | null } = { promise: null };
        inFlightByRequestKey.current.set(requestKey, operation);
        operation.promise = (async () => {
            updatePending(scope, key, 1);
            if (isCurrentScope()) setFailure(null);
            try {
                let result: Awaited<ReturnType<typeof mutateProviderConnection>>;
                try {
                    result = await mutateProviderConnection({ serverId: scope.serverId, request: parsedRequest });
                } catch (caught) {
                    if (!isCurrentScope()) return null;
                    const nextError = providerErrorFromRpcFailure(caught, errorContext);
                    if (nextError.code === 'provider_rpc_mutation_outcome_unknown') {
                        try {
                            await scope.refresh();
                        } catch {
                            // The mutation outcome remains unknown. Recovery must review
                            // current state rather than replacing it with a read failure.
                        }
                        if (!isCurrentScope()) return null;
                    }
                    setFailure({
                        error: nextError,
                        ...providerRetryRecoveryForError(nextError, async () => {
                            await run(parsedRequest, key);
                        }),
                    });
                    return null;
                }
                if (!isCurrentScope()) return null;
                if (result.status === 'error') {
                    setFailure({
                        error: result.error,
                        ...providerRetryRecoveryForError(result.error, async () => {
                            await run(parsedRequest, key);
                        }),
                    });
                    return result;
                }
                try {
                    await scope.refresh();
                } catch (caught) {
                    if (!isCurrentScope()) return result;
                    const refreshError = providerErrorFromRpcFailure(caught, errorContext);
                    setFailure({ error: refreshError, retry: scope.refresh });
                }
                return result;
            } finally {
                if (inFlightByRequestKey.current.get(requestKey) === operation) {
                    inFlightByRequestKey.current.delete(requestKey);
                }
                updatePending(scope, key, -1);
            }
        })();
        return operation.promise;
    }, [updatePending]);
    const isPending = React.useCallback((key: string): boolean => (
        pending.scope === activeScope.current && (pending.countByKey.get(key) ?? 0) > 0
    ), [pending]);
    const clearError = React.useCallback(() => {
        setFailure(null);
    }, []);
    return {
        run,
        isPending,
        error: failure?.error ?? null,
        retry: failure?.retry,
        clearError,
    };
}
