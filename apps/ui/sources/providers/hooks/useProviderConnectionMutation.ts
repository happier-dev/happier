import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc';
import type { z } from 'zod';

import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { mutateProviderConnection, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export function useProviderConnectionMutation(input: Readonly<{
    serverId: string | null;
    refresh: () => Promise<void>;
}>) {
    const [pendingKey, setPendingKey] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
    }> | null>(null);
    const activeScope = React.useRef<Readonly<{
        serverId: string | null;
        refresh: () => Promise<void>;
        revision: number;
    }>>({ serverId: input.serverId, refresh: input.refresh, revision: 0 });
    if (activeScope.current.serverId !== input.serverId || activeScope.current.refresh !== input.refresh) {
        activeScope.current = {
            serverId: input.serverId,
            refresh: input.refresh,
            revision: activeScope.current.revision + 1,
        };
    }
    React.useEffect(() => {
        setPendingKey(null);
        setFailure(null);
    }, [input.refresh, input.serverId]);
    const run = React.useCallback(async (
        request: z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>,
        key = `${request.action}:${request.connectionId}`,
    ) => {
        const requestScopeRevision = activeScope.current.revision;
        const isCurrentScope = () => activeScope.current.revision === requestScopeRevision;
        setPendingKey(key);
        setFailure(null);
        try {
            let result: Awaited<ReturnType<typeof mutateProviderConnection>>;
            try {
                result = await mutateProviderConnection({ serverId: input.serverId, request });
            } catch (caught) {
                if (!isCurrentScope()) return null;
                const nextError = providerErrorFromRpcFailure(caught, {
                    connectionId: request.connectionId,
                    machineId: request.machineId,
                });
                if (nextError.code === 'provider_rpc_mutation_outcome_unknown') {
                    try {
                        await input.refresh();
                    } catch {
                        // The mutation outcome remains unknown. Recovery must review
                        // current state rather than replacing it with a read failure.
                    }
                    if (!isCurrentScope()) return null;
                }
                setFailure({
                    error: nextError,
                    ...providerRetryRecoveryForError(nextError, async () => {
                        await run(request, key);
                    }),
                });
                return null;
            }
            if (!isCurrentScope()) return null;
            if (result.status === 'error') {
                setFailure({
                    error: result.error,
                    ...providerRetryRecoveryForError(result.error, async () => {
                        await run(request, key);
                    }),
                });
                return result;
            }
            try {
                await input.refresh();
            } catch (caught) {
                if (!isCurrentScope()) return result;
                const refreshError = providerErrorFromRpcFailure(caught, {
                    connectionId: request.connectionId,
                    machineId: request.machineId,
                });
                setFailure({ error: refreshError, retry: input.refresh });
            }
            return result;
        } finally {
            if (isCurrentScope()) setPendingKey(null);
        }
    }, [input.refresh, input.serverId]);
    const clearError = React.useCallback(() => {
        setFailure(null);
    }, []);
    return {
        run,
        pendingKey,
        error: failure?.error ?? null,
        retry: failure?.retry,
        clearError,
    };
}
