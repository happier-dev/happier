import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelLoadResponseV1 } from '@happier-dev/protocol/rpc';

import { providerModelRowKey } from '@/providers/models/modelRowKey';
import { cancelProviderModelLoad, loadProviderModel, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export type ProviderModelLoadUiResult = DaemonProviderModelLoadResponseV1
    | Readonly<{ status: 'loaded'; source: 'reconciled' }>
    | Readonly<{ status: 'busy' }>;

type ProviderModelExecutionTarget = Readonly<{
    machineId: string;
    serverId: string | null;
}>;

function waitForProviderModelLoadOrLocalCancellation(
    request: Promise<DaemonProviderModelLoadResponseV1>,
    signal: AbortSignal,
): Promise<DaemonProviderModelLoadResponseV1> {
    if (signal.aborted) {
        return Promise.resolve({ status: 'cancelled', providerMayContinue: true });
    }
    let onAbort = () => {};
    const localCancellation = new Promise<DaemonProviderModelLoadResponseV1>((resolve) => {
        onAbort = () => resolve({ status: 'cancelled', providerMayContinue: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([request, localCancellation]).finally(() => {
        signal.removeEventListener('abort', onAbort);
    });
}

export function useProviderModelLoadAction(input: Readonly<{
    machineId: string | null;
    serverId: string | null;
    refresh: (connectionId: string, modelId: string) => Promise<boolean>;
    /** Re-checks an owner-scoped target immediately before dispatching a model load. */
    resolveExecutionTarget?: () => ProviderModelExecutionTarget | null;
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [loadingModelKey, setLoadingModelKey] = React.useState<string | null>(null);
    const [cancelledProviderMayContinue, setCancelledProviderMayContinue] = React.useState(false);
    const inFlight = React.useRef(false);
    const active = React.useRef<Readonly<{
        connectionId: string;
        modelId: string;
        executionTarget: ProviderModelExecutionTarget;
        controller: AbortController;
        accountLifetime: ActiveServerAccountScopeLifetime | null;
    }> | null>(null);
    const mounted = React.useRef(true);
    const currentAccountLifetime = React.useRef(accountLifetime);
    currentAccountLifetime.current = accountLifetime;

    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            active.current?.controller.abort();
            if (!mounted.current) return;
            setLoadingModelKey(null);
            setCancelledProviderMayContinue(false);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const load = React.useCallback(async (
        connectionId: string,
        modelId: string,
    ): Promise<ProviderModelLoadUiResult> => {
        const operationAccountLifetime = accountLifetime;
        const accountStillCurrent = (): boolean => (
            currentAccountLifetime.current === operationAccountLifetime
            && (operationAccountLifetime?.isCurrent() ?? true)
        );
        if (!accountStillCurrent()) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_authorization_changed', { connectionId }),
            };
        }
        if (!input.machineId) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_machine_unavailable', { connectionId }),
            };
        }
        const initialExecutionTarget: ProviderModelExecutionTarget = {
            machineId: input.machineId,
            serverId: input.serverId,
        };
        const executionTarget = input.resolveExecutionTarget
            ? input.resolveExecutionTarget()
            : initialExecutionTarget;
        // A moved machine must refuse; a replaced device-local routing id for
        // the same machine must be followed, exactly like every other Provider
        // effect. Comparing the routing id here would report a reconnected
        // server as an unavailable endpoint.
        if (!accountStillCurrent()) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_authorization_changed', {
                    connectionId,
                    machineId: initialExecutionTarget.machineId,
                }),
            };
        }
        if (!executionTarget) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_machine_unavailable', {
                    connectionId,
                    machineId: initialExecutionTarget.machineId,
                }),
            };
        }
        if (executionTarget.machineId !== initialExecutionTarget.machineId) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_authorization_changed', {
                    connectionId,
                    machineId: initialExecutionTarget.machineId,
                }),
            };
        }
        if (inFlight.current) return { status: 'busy' };
        inFlight.current = true;
        if (mounted.current) setCancelledProviderMayContinue(false);
        const operation = {
            connectionId,
            modelId,
            executionTarget,
            controller: new AbortController(),
            accountLifetime: operationAccountLifetime,
        };
        active.current = operation;
        if (mounted.current) setLoadingModelKey(providerModelRowKey(connectionId, modelId));
        try {
            let result: DaemonProviderModelLoadResponseV1;
            try {
                result = await waitForProviderModelLoadOrLocalCancellation(
                    loadProviderModel({
                        machineId: executionTarget.machineId,
                        serverId: executionTarget.serverId,
                        connectionId,
                        modelId,
                        signal: operation.controller.signal,
                    }),
                    operation.controller.signal,
                );
            } catch (caught) {
                if (operation.controller.signal.aborted) return {
                    status: 'cancelled',
                    providerMayContinue: true,
                };
                const error = providerErrorFromRpcFailure(caught, {
                    connectionId,
                    machineId: executionTarget.machineId,
                });
                if (error.code === 'provider_rpc_mutation_outcome_unknown') {
                    try {
                        const confirmed = await input.refresh(connectionId, modelId);
                        if (confirmed) return { status: 'loaded', source: 'reconciled' };
                    } catch {
                        // The original daemon operation may still commit after the
                        // client timeout. A failed read cannot make replay safe.
                    }
                    return { status: 'error', error };
                }
                return {
                    status: 'error',
                    error,
                };
            }
            if (result.status === 'loaded') {
                if (!accountStillCurrent()) {
                    return { status: 'cancelled', providerMayContinue: true };
                }
                try {
                    await input.refresh(connectionId, modelId);
                } catch {
                    // A schema-valid loaded response is daemon-authoritative. The
                    // UI refresh is presentation-only and cannot revoke success.
                }
            }
            return result;
        } finally {
            inFlight.current = false;
            if (active.current === operation) active.current = null;
            if (mounted.current && accountStillCurrent()) setLoadingModelKey(null);
        }
    }, [accountLifetime, input.machineId, input.refresh, input.resolveExecutionTarget, input.serverId]);

    const cancel = React.useCallback(async (): Promise<ProviderModelLoadUiResult | null> => {
        const operation = active.current;
        if (!operation) return null;
        if (
            currentAccountLifetime.current !== operation.accountLifetime
            || !(operation.accountLifetime?.isCurrent() ?? true)
        ) {
            operation.controller.abort();
            return { status: 'cancelled', providerMayContinue: true };
        }
        const pendingCancellation = cancelProviderModelLoad({
            machineId: operation.executionTarget.machineId,
            serverId: operation.executionTarget.serverId,
            connectionId: operation.connectionId,
            modelId: operation.modelId,
        });
        operation.controller.abort();
        if (mounted.current) setCancelledProviderMayContinue(true);
        try {
            const result = await pendingCancellation;
            return result.status === 'cancelled'
                ? result
                : { status: 'cancelled', providerMayContinue: true };
        } catch {
            return { status: 'cancelled', providerMayContinue: true };
        }
    }, []);

    return { loadingModelKey, cancelledProviderMayContinue, load, cancel };
}
