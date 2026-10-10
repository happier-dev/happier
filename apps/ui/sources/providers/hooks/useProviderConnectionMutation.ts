import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1, isProviderActionMachineRequiredV1, parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';

import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import type { mutateProviderConnection as MutateProviderConnection } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { CustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/customTemplateV1';

type ProviderConnectionMutationResult = Awaited<ReturnType<typeof MutateProviderConnection>> | null;
type ProviderConnectionExecutionTarget = Readonly<{ machineId: string; serverId: string }>;
type ProviderConnectionMutationScope = Readonly<{
    resolveTarget: () => ProviderConnectionExecutionTarget | null;
    refresh: () => Promise<void>;
    mutate: ReturnType<typeof useProviderActionClient>['mutateProviderConnection'];
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    revision: number;
}>;
type PendingMutationState = Readonly<{
    scope: ProviderConnectionMutationScope;
    countByKey: ReadonlyMap<string, number>;
}>;

/**
 * Every Provider connection write. A modal, confirmation, or prompt can sit
 * between the render that built a request and the moment it runs, so the
 * Account lifetime is checked immediately before the effect. Machine-scoped
 * actions additionally re-resolve the exact target; Account-only edits need no
 * machine authorization.
 */
export function useProviderConnectionMutation(input: Readonly<{
    resolveTarget: () => ProviderConnectionExecutionTarget | null;
    serverId?: string | null;
    refresh: () => Promise<void>;
}>) {
    const capturedServerId = React.useMemo(() => input.serverId ?? input.resolveTarget()?.serverId ?? null, [input.resolveTarget, input.serverId]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const { mutateProviderConnection } = useProviderActionClient(capturedServerId);
    const [failure, setFailure] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
    }> | null>(null);
    const activeScope = React.useRef<ProviderConnectionMutationScope>({
        resolveTarget: input.resolveTarget,
        refresh: input.refresh,
        mutate: mutateProviderConnection,
        serverId: capturedServerId,
        accountLifetime,
        revision: 0,
    });
    const [pending, setPending] = React.useState<PendingMutationState>(() => ({
        scope: activeScope.current,
        countByKey: new Map(),
    }));
    const inFlightByRequestKey = React.useRef(new Map<string, Readonly<{
        promise: Promise<ProviderConnectionMutationResult> | null;
    }>>());
    if (activeScope.current.resolveTarget !== input.resolveTarget || activeScope.current.refresh !== input.refresh
        || activeScope.current.mutate !== mutateProviderConnection || activeScope.current.accountLifetime !== accountLifetime
        || activeScope.current.serverId !== capturedServerId) {
        activeScope.current = {
            resolveTarget: input.resolveTarget,
            refresh: input.refresh,
            mutate: mutateProviderConnection,
            serverId: capturedServerId,
            accountLifetime,
            revision: activeScope.current.revision + 1,
        };
    }
    // The scope this render belongs to. A request built by this render must be
    // decided by this render's resolver: the target owner rebuilds the resolver
    // only when the selected `{ serverIdentityId, machineId }` actually moves,
    // so reading the latest scope instead would let a request captured for one
    // Account be authorized by whichever Account is selected when a modal
    // finally closes — including another profile exposing the same machine id.
    const boundScope = activeScope.current;
    React.useEffect(() => {
        const scope = activeScope.current;
        setPending((current) => current.scope === scope
            ? current
            : { scope, countByKey: new Map() });
        setFailure(null);
    }, [accountLifetime, capturedServerId, input.refresh, input.resolveTarget, mutateProviderConnection]);
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
        request: Parameters<typeof MutateProviderConnection>[0]['request'],
        key = `${request.action}:${request.connectionId}`,
    ): Promise<ProviderConnectionMutationResult> => {
        const scope = boundScope;
        let parsedRequest: typeof request;
        let requiresMachine: boolean;
        try {
            const action = parseProviderActionRequestV1(PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[request.action], request);
            requiresMachine = isProviderActionMachineRequiredV1(action);
            // The operation map above contains only the connection mutation family.
            parsedRequest = action.input as typeof request;
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
        const isCurrentScope = () => activeScope.current === scope && (scope.accountLifetime?.isCurrent() ?? true);
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
                // Re-resolve the canonical target immediately before the write.
                // A rendered snapshot, or a request a modal delayed, may name a
                // machine the user has since moved away from.
                const target = requiresMachine ? scope.resolveTarget() : null;
                if (!(scope.accountLifetime?.isCurrent() ?? true)
                    || requiresMachine && (!target || target.machineId !== parsedRequest.machineId)) {
                    // The user asked for this write, so the refusal is reported
                    // even when the selection has already moved on: a silently
                    // dropped destructive action is indistinguishable from one
                    // that succeeded.
                    setFailure({ error: createProviderErrorV1('provider_authorization_changed', errorContext) });
                    return null;
                }
                let result: Awaited<ReturnType<typeof mutateProviderConnection>>;
                try {
                    result = await scope.mutate({ serverId: target?.serverId ?? scope.serverId, request: parsedRequest });
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
    }, [boundScope, updatePending]);
    const isPending = React.useCallback((key: string): boolean => (
        pending.scope === activeScope.current && (pending.countByKey.get(key) ?? 0) > 0
    ), [pending]);
    const clearError = React.useCallback(() => {
        setFailure(null);
    }, []);
    const updateCustomTemplate = React.useCallback((edit: Readonly<{
        connectionId: string;
        expectedRevision: number;
        template: CustomProviderTemplateV1;
        displayName?: string;
    }>, key = `update:${edit.connectionId}`) => run({ action: 'update', ...edit }, key), [run]);
    return {
        run,
        updateCustomTemplate,
        isPending,
        error: failure?.error ?? null,
        retry: failure?.retry,
        clearError,
    };
}
