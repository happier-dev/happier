import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import * as React from 'react';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/selection/v1';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { modelProjectionScopeKey } from './modelProjectionScopeKey';
import { useProviderModelQueryRetention } from './useProviderModelQueryRetention';
import { beginProviderModelProjectionRead, getProviderModelProjectionSnapshot, subscribeProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

type ProjectionError = Extract<DaemonProviderModelProjectionResponseV1, { status: 'error' }>['error'];

export type ProviderModelProjectionStatus = 'disabled' | 'pending' | 'error' | 'success';

type ProjectionState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    error: ProjectionError | null;
    loading: boolean;
}>;

export function useProviderModelProjection(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    mode?: 'picker' | 'management';
    currentSelection?: ProviderBoundModelRef;
    /** Browsing a source is local picker state; it never changes the selected model. */
    sourceConnectionId?: string;
    connectedServices?: ConnectedServiceBindingsV2;
    favoriteSelections?: readonly ProviderBoundModelRef[];
    /** One gathered Home catalog; only the exact execution Machine resolves delivery. */
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    /** Exact admitted catalog bodies behind a gathered Home projection; progress does not replace them. */
    teamCredentialCatalogSources?: readonly (readonly TeamCredentialResourceCatalogEntryV1[] | null | undefined)[];
}>) {
    const scopeEnabled = Boolean(input.enabled && input.agentTargetKey);
    const { describeProviderModels, ready, pendingApproval, accountScope: { resolution, binding } } = useProviderActionClient(scopeEnabled ? input.serverId : []);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProjectionState>({
        scopeKey: null,
        accountLifetime: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const pendingRead = React.useRef<AbortController | null>(null);
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const selectionKey = input.currentSelection
        ? sessionModelSelectionKey(input.currentSelection)
        : '';
    const scopeKey = modelProjectionScopeKey({ ...input, selectionKey,
        favoriteKeys: input.favoriteSelections?.map(sessionModelSelectionKey) ?? [],
        accountScopeKey: resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : input.serverId,
        credentialKey: binding?.credentialKey ?? null });
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const readSnapshot = React.useCallback(() => scopeEnabled && binding?.credentialKey && binding.isCurrent()
        && (accountLifetime?.isCurrent() ?? true)
        ? getProviderModelProjectionSnapshot(binding.scope, binding.credentialKey, scopeKey) : null,
    [accountLifetime, binding, scopeEnabled, scopeKey]);
    const subscribeSnapshot = React.useCallback((listener: () => void) => scopeEnabled && input.active !== false && binding?.credentialKey && binding.isCurrent()
        ? subscribeProviderModelProjectionSnapshot(binding.scope, binding.credentialKey, scopeKey, listener) : () => {},
    [binding, input.active, scopeEnabled, scopeKey]);
    const data = React.useSyncExternalStore(subscribeSnapshot, readSnapshot, readSnapshot);
    useProviderModelQueryRetention(scopeEnabled ? binding?.scope ?? null : null, binding?.credentialKey ?? null, scopeKey);
    const error = stateMatchesScope ? state.error : null;
    const loading = input.active !== false && scopeEnabled
        && (resolution.kind === 'resolving' || resolution.kind === 'bound')
        && (!ready || !stateMatchesScope || state.loading);
    const status: ProviderModelProjectionStatus = !scopeEnabled
        ? 'disabled'
        : data
            ? 'success'
            : error
                ? 'error'
                : 'pending';
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refreshWithResult = React.useCallback(async (forceRefresh: boolean = true) => {
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        if (!input.enabled || !input.agentTargetKey) {
            setState({ scopeKey, accountLifetime, error: null, loading: false });
            return null;
        }
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && binding?.isCurrent() === true
        );
        if (!requestStillCurrent()) return null;
        if (!ready || !binding?.credentialKey) return null;
        pendingRead.current?.abort();
        const controller = new AbortController();
        pendingRead.current = controller;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, error: null, loading: true });
        const publish = beginProviderModelProjectionRead(binding.scope, binding.credentialKey, scopeKey);
        try {
            const response = await describeProviderModels({
                // Keep the refresh discriminator correlated with its required machine.
                ...(forceRefresh && input.machineId
                    ? { machineId: input.machineId, forceRefresh: true as const }
                    : input.machineId ? { machineId: input.machineId } : {}),
                serverId: input.serverId,
                agentTargetKey: input.agentTargetKey,
                ...(input.mode ? { mode: input.mode } : {}),
                ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}),
                ...(input.sourceConnectionId ? { sourceConnectionId: input.sourceConnectionId } : {}),
                ...(input.connectedServices ? { connectedServices: input.connectedServices } : {}),
                ...(input.favoriteSelections ? { favoriteSelections: [...input.favoriteSelections] } : {}),
                ...(input.teamCredentialResources ? { teamCredentialResources: [...input.teamCredentialResources] } : {}),
            }, { signal: controller.signal });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return null;
            const result = response.status === 'success' && input.teamCredentialResources !== undefined
                && response.teamCredentialResources === undefined
                ? { status: 'error' as const, error: createProviderErrorV1('provider_rpc_response_invalid', {
                    ...(input.machineId ? { machineId: input.machineId } : {}),
                }) }
                : response;
            if (result.status === 'success') {
                publish(result);
                setState({
                    scopeKey, accountLifetime,
                    error: null,
                    loading: true,
                });
            } else {
                setState({
                    scopeKey,
                    accountLifetime,
                    error: result.error,
                    loading: true,
                });
            }
            return result;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return null;
            // A rejected or canceled approval is the person's own decision: nothing ran, nothing failed.
            if (isActionApprovalDeclinedErrorCode((caught as { code?: unknown } | null)?.code)) {
                setState({ scopeKey, accountLifetime, error: null, loading: true });
                return null;
            }
            const providerError = providerErrorFromRpcFailure(caught, {
                ...(input.machineId ? { machineId: input.machineId } : {}),
                ...(input.currentSelection?.providerConnectionId
                    ? { connectionId: input.currentSelection.providerConnectionId }
                    : {}),
            });
            setState({
                scopeKey,
                accountLifetime,
                error: providerError,
                loading: true,
            });
            return { status: 'error' as const, error: providerError };
        } finally {
            if (pendingRead.current === controller) pendingRead.current = null;
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [
        accountLifetime,
        binding,
        describeProviderModels,
        ready,
        input.agentTargetKey,
        input.enabled,
        input.machineId,
        input.mode,
        input.serverId,
        scopeKey,
        selectionKey,
    ]);

    const refresh = React.useCallback(async (): Promise<void> => {
        await refreshWithResult();
    }, [refreshWithResult]);

    React.useEffect(() => {
        void refreshWithResult(false);
        return () => {
            generation.current += 1;
            pendingRead.current?.abort();
            pendingRead.current = null;
        };
    }, [accountLifetime, input.active, refreshWithResult, scopeKey]);

    return {
        data, error,
        refreshFailures: data?.refreshFailures ?? [],
        loading, status, refresh, refreshWithResult,
        pendingApproval,
    };
}
