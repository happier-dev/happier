import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelLoadResponseV1 } from '@happier-dev/protocol/rpc';

import { providerModelRowKey } from '@/providers/models/modelRowKey';
import { cancelProviderModelLoad, loadProviderModel, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export type ProviderModelLoadUiResult = DaemonProviderModelLoadResponseV1
    | Readonly<{ status: 'loaded'; source: 'reconciled' }>
    | Readonly<{ status: 'busy' }>;

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
}>) {
    const [loadingModelKey, setLoadingModelKey] = React.useState<string | null>(null);
    const [cancelledProviderMayContinue, setCancelledProviderMayContinue] = React.useState(false);
    const inFlight = React.useRef(false);
    const active = React.useRef<Readonly<{
        connectionId: string;
        modelId: string;
        controller: AbortController;
    }> | null>(null);
    const mounted = React.useRef(true);

    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const load = React.useCallback(async (
        connectionId: string,
        modelId: string,
    ): Promise<ProviderModelLoadUiResult> => {
        if (!input.machineId) {
            return {
                status: 'error',
                error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId }),
            };
        }
        if (inFlight.current) return { status: 'busy' };
        inFlight.current = true;
        if (mounted.current) setCancelledProviderMayContinue(false);
        const operation = { connectionId, modelId, controller: new AbortController() };
        active.current = operation;
        if (mounted.current) setLoadingModelKey(providerModelRowKey(connectionId, modelId));
        try {
            let result: DaemonProviderModelLoadResponseV1;
            try {
                result = await waitForProviderModelLoadOrLocalCancellation(
                    loadProviderModel({
                        machineId: input.machineId,
                        serverId: input.serverId,
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
                    machineId: input.machineId,
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
            if (mounted.current) setLoadingModelKey(null);
        }
    }, [input.machineId, input.refresh, input.serverId]);

    const cancel = React.useCallback(async (): Promise<ProviderModelLoadUiResult | null> => {
        const operation = active.current;
        if (!operation || !input.machineId) return null;
        const pendingCancellation = cancelProviderModelLoad({
            machineId: input.machineId,
            serverId: input.serverId,
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
    }, [input.machineId, input.serverId]);

    return { loadingModelKey, cancelledProviderMayContinue, load, cancel };
}
