import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import type { SessionModelSelectionV1} from '@happier-dev/protocol/providers/selection/v1';
import type { SessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { DaemonProviderBindingStatusResponseV1 } from '@happier-dev/protocol/rpc';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { readAccountAgentProviderRequirements, readAccountProviderDeclaration,
    type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useProviderCatalogSelection } from '@/sync/store/useProviderCatalog';
import { readProviderCatalogConnection, readProviderCatalogModel,
    type ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
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
    declarationContext?: ProviderDeclarationContext;
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
    const connectionId = input.launchBinding?.connectionId;
    const agentTargetKey = input.selection?.ref.agentTargetKey;
    const modelId = input.selection?.ref.modelId;
    // Observe only this binding's producer-owned facts. An unrelated catalog
    // publication is not a reason to repeat the daemon's full binding read.
    const bindingFacts = useProviderCatalogSelection(useShallow((snapshot: ProviderCatalogSnapshot | null) => {
        const catalog = snapshot?.data;
        const secrets = connectionId ? catalog?.secretBindingsByConnectionId[connectionId] : undefined;
        return [
            connectionId ? readProviderCatalogConnection(snapshot?.scope, connectionId) : null,
            catalog?.accountGrants.find(row => row.connectionId === connectionId) ?? null,
            catalog?.machineGrants.find(row => row.connectionId === connectionId && row.machineId === input.machineId) ?? null,
            secrets?.account ?? null,
            input.machineId ? secrets?.byMachineId?.[input.machineId] ?? null : null,
            connectionId && modelId ? readProviderCatalogModel(snapshot?.scope, connectionId, modelId) : null,
            catalog?.experimentalBindingConfirmations.find(row => row.connectionId === connectionId
                && row.agentTargetKey === agentTargetKey && row.modelId === null) ?? null,
            catalog?.experimentalBindingConfirmations.find(row => row.connectionId === connectionId
                && row.agentTargetKey === agentTargetKey && row.modelId === modelId) ?? null,
        ] as const;
    }), binding?.scope ?? null, { enabled: requestable });
    const contributionKey = bindingFacts[0]?.source.kind === 'contribution'
        ? bindingFacts[0].source.contributionKey : input.launchBinding?.contributionKey;
    const providerDeclaration = React.useMemo(() => contributionKey && input.declarationContext
        ? readAccountProviderDeclaration(contributionKey, input.declarationContext) : null,
    [contributionKey, input.declarationContext]);
    const agentRequirements = React.useMemo(() => agentTargetKey && input.declarationContext
        ? readAccountAgentProviderRequirements(agentTargetKey, input.declarationContext) : null,
    [agentTargetKey, input.declarationContext]);
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
    }, [accountLifetime, refresh, scopeKey, bindingFacts, providerDeclaration?.definition, providerDeclaration?.provenance, agentRequirements]);

    const previousCompletedTurnObservedAt = React.useRef(input.completedTurnObservedAt);
    const previousBindingRefusalObservedAt = React.useRef(input.bindingRefusalObservedAt);
    React.useEffect(() => {
        const previous = previousCompletedTurnObservedAt.current;
        previousCompletedTurnObservedAt.current = input.completedTurnObservedAt;
        const previousRefusal = previousBindingRefusalObservedAt.current;
        previousBindingRefusalObservedAt.current = input.bindingRefusalObservedAt;
        // A recovered turn invalidates an earlier transient read failure. Keep
        // the existing attention state until its canonical binding read settles.
        const needsAttention = stateMatchesScope && (state.error !== null || state.status !== null && state.status.status !== 'current');
        // The runner can discover a binding change before this client sees any catalog update.
        const bindingRefused = input.bindingRefusalObservedAt != null && input.bindingRefusalObservedAt !== previousRefusal;
        if (bindingRefused || (needsAttention && input.completedTurnObservedAt != null && input.completedTurnObservedAt !== previous)) {
            void refresh();
        }
    }, [input.completedTurnObservedAt, input.bindingRefusalObservedAt, refresh, stateMatchesScope, state.error, state.status]);

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
