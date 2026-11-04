import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1, isProviderActionMachineRequiredV1, parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';

import { providerRetryRecoveryForError } from '@/providers/connection/recovery';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import type { mutateProviderConnection as MutateProviderConnection } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { CustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/customTemplateV1';
import type { ProviderConnectionRefreshScope } from './useProviderConnections';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type ProviderConnectionMutationResult = Awaited<ReturnType<typeof MutateProviderConnection>> | null;
type ProviderConnectionExecutionTarget = Readonly<{ machineId: string; serverId: string }>;
type ProviderConnectionMutationScope = {
    resolveTarget: () => ProviderConnectionExecutionTarget | null;
    machineRevision: number;
    refresh: (scope?: ProviderConnectionRefreshScope) => Promise<void>;
    mutate: ReturnType<typeof useProviderActionClient>['mutateProviderConnection'];
    readonly serverId: string | null;
    readonly accountLifetime: ActiveServerAccountScopeLifetime | null;
    readonly revision: number;
};
type PendingMutationState = Readonly<{
    scope: ProviderConnectionMutationScope;
    countByKey: ReadonlyMap<string, number>;
}>;

function isDeclinedApproval(caught: unknown): boolean {
    const code = typeof caught === 'object' && caught !== null ? (caught as { code?: unknown }).code : undefined;
    return isActionApprovalDeclinedErrorCode(code);
}

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
    initiatingLifetime?: ServerAccountScopeLifetime | null;
    refresh: (scope?: ProviderConnectionRefreshScope) => Promise<void>;
}>) {
    const capturedServerId = React.useMemo(() => input.serverId ?? input.resolveTarget()?.serverId ?? null, [input.resolveTarget, input.serverId]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const { mutateProviderConnection, pendingApproval } = useProviderActionClient(capturedServerId, input.initiatingLifetime);
    const [failure, setFailure] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
        machineRevision?: number;
        /** The control (its pending key) whose write failed, so its page can show the failure beside it. */
        key?: string;
    }> | null>(null);
    const activeScope = React.useRef<ProviderConnectionMutationScope>({
        resolveTarget: input.resolveTarget,
        refresh: input.refresh,
        mutate: mutateProviderConnection,
        serverId: capturedServerId,
        accountLifetime,
        revision: 0,
        machineRevision: 0,
    });
    const [pending, setPending] = React.useState<PendingMutationState>(() => ({
        scope: activeScope.current,
        countByKey: new Map(),
    }));
    const inFlightByRequestKey = React.useRef(new Map<string, Readonly<{
        promise: Promise<ProviderConnectionMutationResult> | null;
        scope: ProviderConnectionMutationScope;
        machineRevision: number;
        controller: AbortController | null;
    }>>());
    if (activeScope.current.accountLifetime !== accountLifetime
        || activeScope.current.serverId !== capturedServerId) {
        activeScope.current = {
            resolveTarget: input.resolveTarget,
            refresh: input.refresh,
            mutate: mutateProviderConnection,
            serverId: capturedServerId,
            accountLifetime,
            revision: activeScope.current.revision + 1,
            machineRevision: 0,
        };
    } else {
        if (activeScope.current.resolveTarget !== input.resolveTarget) {
            activeScope.current.machineRevision += 1;
            activeScope.current.resolveTarget = input.resolveTarget;
        }
        // Callback refreshes do not retire an admitted Account operation. Keep
        // current presentation callbacks without dropping its approval result.
        activeScope.current.refresh = input.refresh;
        activeScope.current.mutate = mutateProviderConnection;
    }
    // Account writes keep their Home/Account scope as machines change. Machine
    // writes must still be decided by this render's resolver: the target owner rebuilds the resolver
    // only when the selected `{ serverIdentityId, machineId }` actually moves,
    // so reading the latest scope instead would let a request captured for one
    // Account be authorized by whichever Account is selected when a modal
    // finally closes — including another profile exposing the same machine id.
    const boundScope = activeScope.current;
    const boundMachineRevision = boundScope.machineRevision;
    const boundResolveTarget = input.resolveTarget;
    React.useEffect(() => {
        for (const operation of inFlightByRequestKey.current.values()) {
            if (operation.scope !== boundScope || operation.machineRevision !== boundMachineRevision) {
                operation.controller?.abort();
            }
        }
    }, [boundMachineRevision, boundScope]);
    React.useEffect(() => {
        const scope = activeScope.current;
        setPending((current) => current.scope === scope
            ? current
            : { scope, countByKey: new Map() });
        setFailure(null);
    }, [accountLifetime, capturedServerId]);
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
        options?: Pick<UiActionOperation, 'confirmed'>,
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
                    key,
                    error: nextError,
                    ...providerRetryRecoveryForError(nextError, async () => {
                        await run(request, key, options);
                    }),
                });
            }
            return Promise.resolve(null);
        }
        const pendingKey = requiresMachine ? stableJsonStringify([boundMachineRevision, key]) : key;
        const requestKey = stableJsonStringify([scope.revision, pendingKey, parsedRequest, options?.confirmed === true]);
        const existing = inFlightByRequestKey.current.get(requestKey);
        if (existing?.promise) return existing.promise;
        const isCurrentScope = () => activeScope.current === scope && (scope.accountLifetime?.isCurrent() ?? true)
            && (!requiresMachine || scope.machineRevision === boundMachineRevision);
        const errorContext = {
            machineId: parsedRequest.machineId,
            ...('connectionId' in parsedRequest ? { connectionId: parsedRequest.connectionId } : {}),
        };
        const failureScope = requiresMachine ? { machineRevision: boundMachineRevision } : {};
        const operation = {
            promise: null as Promise<ProviderConnectionMutationResult> | null,
            scope,
            machineRevision: boundMachineRevision,
            // Account configuration edits retain their original authority as machine selection moves.
            controller: requiresMachine ? new AbortController() : null,
        };
        inFlightByRequestKey.current.set(requestKey, operation);
        operation.promise = (async () => {
            updatePending(scope, pendingKey, 1);
            if (isCurrentScope()) setFailure(null);
            try {
                // Re-resolve the canonical target immediately before the write.
                // A rendered snapshot, or a request a modal delayed, may name a
                // machine the user has since moved away from.
                const target = requiresMachine ? boundResolveTarget() : null;
                if (!(scope.accountLifetime?.isCurrent() ?? true)
                    || requiresMachine && (scope.machineRevision !== boundMachineRevision || !target || target.machineId !== parsedRequest.machineId)) {
                    // The user asked for this write, so the refusal is reported
                    // even when the selection has already moved on: a silently
                    // dropped destructive action is indistinguishable from one
                    // that succeeded.
                    setFailure({ key, error: createProviderErrorV1('provider_authorization_changed', errorContext) });
                    return null;
                }
                let result: Awaited<ReturnType<typeof mutateProviderConnection>>;
                try {
                    result = await scope.mutate({ serverId: target?.serverId ?? scope.serverId, request: parsedRequest },
                        { ...options, ...(operation.controller ? { signal: operation.controller.signal } : {}) });
                } catch (caught) {
                    if (!isCurrentScope()) return null;
                    // A rejected or canceled approval is the person's own decision: nothing ran, nothing failed.
                    if (isDeclinedApproval(caught)) return null;
                    const nextError = providerErrorFromRpcFailure(caught, errorContext);
                    if (nextError.code === 'provider_rpc_mutation_outcome_unknown') {
                        try {
                            await scope.refresh(requiresMachine ? 'machine' : 'account');
                        } catch {
                            // The mutation outcome remains unknown. Recovery must review
                            // current state rather than replacing it with a read failure.
                        }
                        if (!isCurrentScope()) return null;
                    }
                    setFailure({
                        ...failureScope,
                        key,
                        error: nextError,
                        ...providerRetryRecoveryForError(nextError, async () => {
                            await run(parsedRequest, key, options);
                        }),
                    });
                    return null;
                }
                if (!isCurrentScope()) return null;
                if (result.status === 'error') {
                    setFailure({
                        ...failureScope,
                        key,
                        error: result.error,
                        ...providerRetryRecoveryForError(result.error, async () => {
                            await run(parsedRequest, key, options);
                        }),
                    });
                    return result;
                }
                // The Account writer has already published the acknowledged row.
                // Machine/runtime presentation revalidation has its own recovery.
                fireAndForget(scope.refresh(requiresMachine ? 'machine' : 'account'), {
                    onError: caught => {
                        if (!isCurrentScope()) return;
                        const refreshError = providerErrorFromRpcFailure(caught, errorContext);
                        setFailure({ ...failureScope, key, error: refreshError, retry: () => scope.refresh(requiresMachine ? 'machine' : 'account') });
                    },
                });
                return result;
            } finally {
                if (inFlightByRequestKey.current.get(requestKey) === operation) {
                    inFlightByRequestKey.current.delete(requestKey);
                }
                updatePending(scope, pendingKey, -1);
            }
        })();
        return operation.promise;
    }, [boundScope, boundMachineRevision, boundResolveTarget, updatePending]);
    const isPending = React.useCallback((key: string): boolean => (
        pending.scope === activeScope.current && ((pending.countByKey.get(key) ?? 0) > 0
            || (pending.countByKey.get(stableJsonStringify([activeScope.current.machineRevision, key])) ?? 0) > 0)
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
    const visibleFailure = failure?.machineRevision === undefined || failure.machineRevision === boundMachineRevision ? failure : null;
    return {
        run,
        updateCustomTemplate,
        isPending,
        /** The approval a write is waiting for, while it waits (its page can be reopened). */
        pendingApproval,
        error: visibleFailure?.error ?? null,
        /** The pending key of the control whose write failed (`enable:account`, `machine:<id>`, …). */
        errorKey: visibleFailure?.key ?? null,
        retry: visibleFailure?.retry,
        clearError,
    };
}
