import * as React from 'react';

import type { MachinePoolResolveInputV1, MachinePoolResolveResultV1 } from '@happier-dev/protocol';

import type { ServerScopedMachinePoolSelection } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { randomUUID } from '@/platform/randomUUID';
import { resolveMachinePool } from '@/sync/ops/machinePools';
import { isActionAccountScopeChangedError } from '@/sync/ops/actions/defaultActionExecutor';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';

type UnavailableReason = Extract<MachinePoolResolveResultV1, { kind: 'unavailable' }>['reason'];

export type MachinePoolSelectionStatus =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'resolving'; serverId: string; accountId: string; poolId: string }>
    | Readonly<{ kind: 'unavailable'; serverId: string; accountId: string; poolId: string; reason: UnavailableReason }>
    | Readonly<{ kind: 'error'; serverId: string; accountId: string; poolId: string }>;

type PoolSelectionPurpose = Readonly<{ purpose?: 'session' }> | Readonly<Pick<
    Extract<MachinePoolResolveInputV1, { purpose: 'finite' | 'service-start' }>, 'purpose' | 'workspace' | 'memoryDemand'
>>;

export function useMachinePoolSelection(params: Readonly<{
    requestKey: string;
    /** The stable draft identity already produced a committed Pool choice before this mount. */
    requestKeyAlreadyConsumed?: boolean;
    scopeKey?: string;
    onResolved: (target: Readonly<{ serverId: string; poolId: string; machineId: string }>) => void;
}> & PoolSelectionPurpose) {
    const [status, setStatus] = React.useState<MachinePoolSelectionStatus>({ kind: 'idle' });
    const generationRef = React.useRef(0);
    const activeAttemptRef = React.useRef<Readonly<{ selectionKey: string; requestKey: string }> | null>(null);
    const baseRequestConsumedRef = React.useRef(params.requestKeyAlreadyConsumed === true);
    const onResolvedRef = React.useRef(params.onResolved);
    onResolvedRef.current = params.onResolved;
    const placementKey = JSON.stringify(params.purpose === 'finite' || params.purpose === 'service-start'
        ? [params.purpose, params.workspace, params.memoryDemand ?? null] : ['session']);
    const requestContextKey = `${params.requestKey}\u0000${params.scopeKey ?? ''}\u0000${placementKey}`;
    const latestRequestContextKeyRef = React.useRef(requestContextKey);
    latestRequestContextKeyRef.current = requestContextKey;

    const cancelPendingSelection = React.useCallback(() => {
        generationRef.current += 1;
        activeAttemptRef.current = null;
        setStatus({ kind: 'idle' });
    }, []);

    const requestContextRef = React.useRef({
        requestKey: params.requestKey,
        scopeKey: params.scopeKey,
        placementKey,
    });
    React.useEffect(() => {
        const previous = requestContextRef.current;
        const requestChanged = previous.requestKey !== params.requestKey;
        const scopeChanged = previous.scopeKey !== params.scopeKey;
        if (!requestChanged && !scopeChanged && previous.placementKey === placementKey) {
            if (params.requestKeyAlreadyConsumed === true) baseRequestConsumedRef.current = true;
            return;
        }
        requestContextRef.current = {
            requestKey: params.requestKey,
            scopeKey: params.scopeKey,
            placementKey,
        };
        // A request identity is the custody boundary for a pool resolve. If the
        // picker is reused for a newer draft or exact authoring context while
        // the old Home request is still in flight, its result must stay inert.
        cancelPendingSelection();
        // Target/Home changes end an attempt, but they cannot make the same draft identity unused
        // again. Only a genuinely different draft gets its own stable first-attempt identity.
        if (requestChanged) {
            baseRequestConsumedRef.current = params.requestKeyAlreadyConsumed === true;
        } else if (params.requestKeyAlreadyConsumed === true) {
            baseRequestConsumedRef.current = true;
        }
    }, [cancelPendingSelection, params.requestKey, params.requestKeyAlreadyConsumed, params.scopeKey, placementKey]);

    React.useEffect(() => () => {
        generationRef.current += 1;
    }, []);

    const selectPool = React.useCallback(async (selection: ServerScopedMachinePoolSelection): Promise<boolean> => {
        const generation = generationRef.current + 1;
        const capturedRequestContextKey = latestRequestContextKeyRef.current;
        generationRef.current = generation;
        const serverId = selection.serverId;
        const accountId = selection.accountId;
        const poolId = selection.pool.pool.id;
        const selectionKey = serverAccountScopedResourceKey({ serverId, accountId }, 'machine_pool', poolId);
        let activeAttempt = activeAttemptRef.current;
        if (activeAttempt?.selectionKey !== selectionKey) {
            const stableRequestKey = params.requestKey.trim();
            const requestKey = stableRequestKey && !baseRequestConsumedRef.current
                ? stableRequestKey
                : randomUUID();
            baseRequestConsumedRef.current = true;
            activeAttempt = { selectionKey, requestKey };
            activeAttemptRef.current = activeAttempt;
        }
        const requestKey = activeAttempt.requestKey;
        setStatus({ kind: 'resolving', serverId, accountId, poolId });

        let resolved = false;
        let settlementHandledInsideAccount = false;
        try {
            const input: MachinePoolResolveInputV1 = params.purpose === 'finite' || params.purpose === 'service-start' ? {
                poolId, requestKey, purpose: params.purpose, workspace: params.workspace,
                ...(params.memoryDemand ? { memoryDemand: params.memoryDemand } : {}),
            } : {
                poolId,
                requestKey,
            };
            await resolveMachinePool(serverId, input, {
                expectedAccountId: accountId,
                onSettled: (settlement) => {
                    settlementHandledInsideAccount = true;
                    if (
                        generationRef.current !== generation
                        || latestRequestContextKeyRef.current !== capturedRequestContextKey
                    ) return;
                    if (settlement.kind === 'error') {
                        setStatus({ kind: 'error', serverId, accountId, poolId });
                        return;
                    }
                    if (settlement.result.kind === 'unavailable') {
                        setStatus({
                            kind: 'unavailable',
                            serverId,
                            accountId,
                            poolId,
                            reason: settlement.result.reason,
                        });
                        return;
                    }

                    resolved = true;
                    setStatus({ kind: 'idle' });
                    activeAttemptRef.current = null;
                    onResolvedRef.current({
                        serverId,
                        poolId: settlement.result.poolId,
                        machineId: settlement.result.machineId,
                    });
                },
            });
        } catch (error) {
            if (
                !settlementHandledInsideAccount
                && generationRef.current === generation
                && latestRequestContextKeyRef.current === capturedRequestContextKey
            ) {
                if (isActionAccountScopeChangedError(error)) {
                    activeAttemptRef.current = null;
                    setStatus({ kind: 'idle' });
                } else {
                    setStatus({ kind: 'error', serverId, accountId, poolId });
                }
            }
            return false;
        }
        return resolved;
    }, [params.requestKey, placementKey]);

    return {
        status,
        selectPool,
        cancelPendingSelection,
    } as const;
}
