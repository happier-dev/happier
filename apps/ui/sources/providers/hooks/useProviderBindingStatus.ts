import * as React from 'react';
import type { ProviderErrorV1, SessionModelSelectionV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
import type { DaemonProviderBindingStatusResponseV1 } from '@happier-dev/protocol/rpc';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export type ProviderBindingStatusResult =
    | DaemonProviderBindingStatusResponseV1
    | Readonly<{ status: 'selection_changed' }>;

type ProviderBindingStatusState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    status: ProviderBindingStatusResult | null;
    error: ProviderErrorV1 | null;
    loading: boolean;
}>;

export function useProviderBindingStatus(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    selection: SessionModelSelectionV1 | null;
    selectionIntentPresent?: boolean;
    launchBinding: SessionProviderBindingMetadataV1 | null;
    completedTurnObservedAt?: number | null;
    bindingRefusalObservedAt?: number | null;
}>) {
    const { describeProviderBindingStatus, ready, pendingApproval, accountScope: { resolution, binding } } = useProviderActionClient(input.serverId);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderBindingStatusState>({
        scopeKey: null,
        accountLifetime: null,
        status: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const pendingRead = React.useRef<AbortController | null>(null);
    const selectionKey = input.selection
        ? `${input.selection.ref.agentTargetKey}\0${input.selection.ref.providerConnectionId ?? ''}\0${input.selection.ref.modelId}\0${input.selection.updatedAt}`
        : '';
    const bindingKey = input.launchBinding
        ? `${input.launchBinding.connectionId}\0${input.launchBinding.model?.id ?? ''}\0${input.launchBinding.connectionRevision}\0${input.launchBinding.bindingSecurityFingerprint}`
        : '';
    const scopeKey = JSON.stringify([
        input.enabled, input.machineId, input.serverId, input.selectionIntentPresent === true, selectionKey, bindingKey,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null,
    ]);
    const requestable = Boolean(
        input.enabled
        && input.machineId
        && input.selection
        && input.launchBinding
        && input.selection.ref.providerConnectionId === input.launchBinding.connectionId
        && (!input.launchBinding.model || input.selection.ref.modelId === input.launchBinding.model.id),
    );
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, status: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && binding?.isCurrent() === true
        );
        if (!requestStillCurrent()) return;
        if (!input.enabled || !input.machineId || !input.launchBinding) {
            setState({ scopeKey, accountLifetime, status: null, error: null, loading: false });
            return;
        }
        if (!input.selection) {
            setState({
                scopeKey,
                accountLifetime,
                status: input.selectionIntentPresent ? { status: 'selection_changed' } : null,
                error: null,
                loading: false,
            });
            return;
        }
        if (input.selection.ref.providerConnectionId !== input.launchBinding.connectionId) {
            setState({
                scopeKey,
                accountLifetime,
                status: { status: 'selection_changed' },
                error: null,
                loading: false,
            });
            return;
        }
        if (
            input.launchBinding.model
            && input.selection.ref.modelId !== input.launchBinding.model.id
        ) {
            setState({
                scopeKey,
                accountLifetime,
                status: { status: 'selection_changed' },
                error: null,
                loading: false,
            });
            return;
        }
        if (!ready) return;
        pendingRead.current?.abort();
        const controller = new AbortController();
        pendingRead.current = controller;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, status: null, error: null, loading: true });
        try {
            const result = await describeProviderBindingStatus({
                serverId: input.serverId,
                request: {
                    machineId: input.machineId,
                    agentTargetKey: input.selection.ref.agentTargetKey,
                    selection: input.selection,
                    launchBinding: input.launchBinding,
                },
            }, { signal: controller.signal });
            if (generation.current !== requestGeneration || !requestStillCurrent()) return;
            setState({ scopeKey, accountLifetime, status: result, error: null, loading: true });
        } catch (caught) {
            if (generation.current !== requestGeneration || !requestStillCurrent()) return;
            setState({
                scopeKey,
                accountLifetime,
                status: null,
                error: providerErrorFromRpcFailure(caught, {
                    connectionId: input.launchBinding.connectionId,
                    machineId: input.machineId,
                }),
                loading: true,
            });
        } finally {
            if (pendingRead.current === controller) pendingRead.current = null;
            if (generation.current === requestGeneration && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [accountLifetime, binding, describeProviderBindingStatus, ready, bindingKey, input.enabled, input.machineId, input.selectionIntentPresent, input.serverId, scopeKey, selectionKey]);

    React.useEffect(() => {
        void refresh();
        return () => {
            generation.current += 1;
            pendingRead.current?.abort();
            pendingRead.current = null;
        };
    }, [accountLifetime, refresh, scopeKey]);

    const previousCompletedTurnObservedAt = React.useRef(input.completedTurnObservedAt);
    const previousBindingRefusalObservedAt = React.useRef(input.bindingRefusalObservedAt);
    React.useEffect(() => {
        const previous = previousCompletedTurnObservedAt.current;
        previousCompletedTurnObservedAt.current = input.completedTurnObservedAt;
        const previousRefusal = previousBindingRefusalObservedAt.current;
        previousBindingRefusalObservedAt.current = input.bindingRefusalObservedAt;
        // A recovered turn invalidates an earlier transient read failure. Keep
        // the existing attention state until its canonical binding read settles.
        // The runner can discover a binding change before this client sees any catalog update.
        const bindingRefused = input.bindingRefusalObservedAt != null && input.bindingRefusalObservedAt !== previousRefusal;
        if (bindingRefused || (input.completedTurnObservedAt != null && input.completedTurnObservedAt !== previous)) {
            void refresh();
        }
    }, [input.completedTurnObservedAt, input.bindingRefusalObservedAt, refresh]);

    return {
        status: stateMatchesScope ? state.status : null,
        error: stateMatchesScope ? state.error : null,
        loading: requestable
            && (resolution.kind === 'resolving' || resolution.kind === 'bound')
            && (!ready || !stateMatchesScope || state.loading),
        refresh,
        pendingApproval,
    };
}
