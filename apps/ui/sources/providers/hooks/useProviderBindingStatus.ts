import * as React from 'react';
import type { ProviderErrorV1, SessionModelSelectionV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
import type { DaemonProviderBindingStatusResponseV1 } from '@happier-dev/protocol/rpc';

import { describeProviderBindingStatus, providerErrorFromRpcFailure } from '@/providers/rpc/client';

export type ProviderBindingStatusResult =
    | DaemonProviderBindingStatusResponseV1
    | Readonly<{ status: 'selection_changed' }>;

export function useProviderBindingStatus(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    selection: SessionModelSelectionV1 | null;
    selectionIntentPresent?: boolean;
    launchBinding: SessionProviderBindingMetadataV1 | null;
}>) {
    const [status, setStatus] = React.useState<ProviderBindingStatusResult | null>(null);
    const [error, setError] = React.useState<ProviderErrorV1 | null>(null);
    const [loading, setLoading] = React.useState(false);
    const generation = React.useRef(0);
    const selectionKey = input.selection
        ? `${input.selection.ref.agentTargetKey}\0${input.selection.ref.providerConnectionId ?? ''}\0${input.selection.ref.modelId}\0${input.selection.updatedAt}`
        : '';
    const bindingKey = input.launchBinding
        ? `${input.launchBinding.connectionId}\0${input.launchBinding.model?.id ?? ''}\0${input.launchBinding.connectionRevision}\0${input.launchBinding.bindingSecurityFingerprint}`
        : '';
    const scopeKey = JSON.stringify([
        input.enabled, input.machineId, input.serverId, input.selectionIntentPresent === true, selectionKey, bindingKey,
    ]);
    const activeScopeKey = React.useRef<string | null>(null);

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!input.enabled || !input.machineId || !input.launchBinding) {
            setStatus(null);
            setError(null);
            setLoading(false);
            return;
        }
        if (!input.selection) {
            setStatus(input.selectionIntentPresent ? { status: 'selection_changed' } : null);
            setError(null);
            setLoading(false);
            return;
        }
        if (input.selection.ref.providerConnectionId !== input.launchBinding.connectionId) {
            setStatus({ status: 'selection_changed' });
            setError(null);
            setLoading(false);
            return;
        }
        if (
            input.launchBinding.model
            && input.selection.ref.modelId !== input.launchBinding.model.id
        ) {
            setStatus({ status: 'selection_changed' });
            setError(null);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const result = await describeProviderBindingStatus({
                serverId: input.serverId,
                request: {
                    machineId: input.machineId,
                    agentTargetKey: input.selection.ref.agentTargetKey,
                    selection: input.selection,
                    launchBinding: input.launchBinding,
                },
            });
            if (generation.current === requestGeneration) {
                setStatus(result);
                setError(null);
            }
        } catch (caught) {
            if (generation.current === requestGeneration) {
                setStatus(null);
                setError(providerErrorFromRpcFailure(caught, {
                    connectionId: input.launchBinding.connectionId,
                    machineId: input.machineId,
                }));
            }
        } finally {
            if (generation.current === requestGeneration) setLoading(false);
        }
    }, [bindingKey, input.enabled, input.machineId, input.selectionIntentPresent, input.serverId, selectionKey]);

    React.useEffect(() => {
        if (activeScopeKey.current !== scopeKey) {
            activeScopeKey.current = scopeKey;
            setStatus(null);
            setError(null);
        }
        void refresh();
        return () => { generation.current += 1; };
    }, [refresh, scopeKey]);

    return { status, error, loading, refresh };
}
