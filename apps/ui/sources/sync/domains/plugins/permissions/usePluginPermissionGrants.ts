import * as React from 'react';

import type {
    PluginPermissionGrantDecisionInput,
    PluginPermissionGrantIdentity,
    PluginPermissionGrantListInput,
    PluginPermissionGrantRevokeInput,
    PluginPermissionPendingGrantRequest,
} from './types';
import type { PluginPermissionGrantActions } from './actions';
import {
    applyPluginPermissionGrantApproved,
    applyPluginPermissionGrantList,
    applyPluginPermissionGrantRequestDismissed,
    applyPluginPermissionGrantRevoked,
    beginPluginPermissionGrantRefresh,
    createEmptyPluginPermissionGrantState,
    hasPluginPermissionGrant,
    markPluginPermissionGrantRefreshFailed,
    selectPluginPermissionPendingRequests,
    upsertPluginPermissionPendingRequest,
    type PluginPermissionGrantState,
} from './store';
import { pluginPermissionGrantScopeKey } from './types';

export type UsePluginPermissionGrantsParams = Readonly<{
    actions: PluginPermissionGrantActions;
    enabled: boolean;
    listInput: PluginPermissionGrantListInput | null;
}>;

export type UsePluginPermissionGrantsResult = Readonly<{
    state: PluginPermissionGrantState;
    pendingRequests: readonly PluginPermissionPendingGrantRequest[];
    hasGrant: (input: Partial<PluginPermissionGrantIdentity>) => boolean;
    refresh: () => Promise<void>;
    grant: (input: PluginPermissionGrantDecisionInput) => Promise<void>;
    revoke: (input: PluginPermissionGrantRevokeInput) => Promise<void>;
    dismissRequest: (input: PluginPermissionGrantDecisionInput) => Promise<void>;
    upsertPendingRequest: (request: PluginPermissionPendingGrantRequest) => void;
}>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'plugin_permission_grants_refresh_failed';
}

function listInputKey(input: PluginPermissionGrantListInput | null): string {
    if (!input) return 'none';
    return JSON.stringify({
        pluginId: input.pluginId ?? null,
        capability: input.capability ?? null,
        targetScope: input.targetScope ? pluginPermissionGrantScopeKey(input.targetScope) : null,
        includeRevoked: input.includeRevoked ?? false,
        includeResolvedRequests: input.includeResolvedRequests ?? false,
        limit: input.limit ?? 50,
    });
}

export function usePluginPermissionGrants(params: UsePluginPermissionGrantsParams): UsePluginPermissionGrantsResult {
    const refreshInputKey = listInputKey(params.listInput);
    const scopeKey = params.enabled && params.listInput ? refreshInputKey : `inactive:${refreshInputKey}`;
    const emptyState = React.useMemo(createEmptyPluginPermissionGrantState, [scopeKey]);
    const [scopedState, setScopedState] = React.useState<Readonly<{
        scopeKey: string;
        state: PluginPermissionGrantState;
    }>>(() => ({ scopeKey, state: createEmptyPluginPermissionGrantState() }));
    const state = scopedState.scopeKey === scopeKey ? scopedState.state : emptyState;
    const refreshSequenceRef = React.useRef(0);

    const refresh = React.useCallback(async () => {
        const refreshSequence = ++refreshSequenceRef.current;
        if (!params.enabled || !params.listInput) return;
        const requestScopeKey = refreshInputKey;
        setScopedState((current) => ({
            scopeKey: requestScopeKey,
            state: beginPluginPermissionGrantRefresh(
                current.scopeKey === requestScopeKey
                    ? current.state
                    : createEmptyPluginPermissionGrantState(),
            ),
        }));
        try {
            const response = await params.actions.list(params.listInput);
            if (refreshSequenceRef.current !== refreshSequence) return;
            setScopedState((current) => current.scopeKey === requestScopeKey
                ? { scopeKey: requestScopeKey, state: applyPluginPermissionGrantList(current.state, response) }
                : current);
        } catch (error) {
            if (refreshSequenceRef.current !== refreshSequence) return;
            setScopedState((current) => current.scopeKey === requestScopeKey
                ? {
                      scopeKey: requestScopeKey,
                      state: markPluginPermissionGrantRefreshFailed(current.state, errorMessage(error)),
                  }
                : current);
        }
    }, [params.actions, params.enabled, refreshInputKey]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    React.useEffect(() => {
        if (params.enabled && params.listInput) return;
        ++refreshSequenceRef.current;
        setScopedState({ scopeKey, state: createEmptyPluginPermissionGrantState() });
    }, [params.enabled, refreshInputKey, scopeKey]);

    const grant = React.useCallback(async (input: PluginPermissionGrantDecisionInput) => {
        if (!params.enabled) return;
        const mutationScopeKey = scopeKey;
        try {
            const result = await params.actions.grant(input);
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? { scopeKey: mutationScopeKey, state: applyPluginPermissionGrantApproved(current.state, result) }
                : current);
        } catch (error) {
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? {
                      scopeKey: mutationScopeKey,
                      state: markPluginPermissionGrantRefreshFailed(current.state, errorMessage(error)),
                  }
                : current);
        }
    }, [params.actions, params.enabled, scopeKey]);

    const revoke = React.useCallback(async (input: PluginPermissionGrantRevokeInput) => {
        if (!params.enabled) return;
        const mutationScopeKey = scopeKey;
        try {
            const result = await params.actions.revoke(input);
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? { scopeKey: mutationScopeKey, state: applyPluginPermissionGrantRevoked(current.state, result) }
                : current);
        } catch (error) {
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? {
                      scopeKey: mutationScopeKey,
                      state: markPluginPermissionGrantRefreshFailed(current.state, errorMessage(error)),
                  }
                : current);
        }
    }, [params.actions, params.enabled, scopeKey]);

    const dismissRequest = React.useCallback(async (input: PluginPermissionGrantDecisionInput) => {
        if (!params.enabled) return;
        const mutationScopeKey = scopeKey;
        try {
            const result = await params.actions.dismissRequest(input);
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? {
                      scopeKey: mutationScopeKey,
                      state: applyPluginPermissionGrantRequestDismissed(current.state, result),
                  }
                : current);
        } catch (error) {
            setScopedState((current) => current.scopeKey === mutationScopeKey
                ? {
                      scopeKey: mutationScopeKey,
                      state: markPluginPermissionGrantRefreshFailed(current.state, errorMessage(error)),
                  }
                : current);
        }
    }, [params.actions, params.enabled, scopeKey]);

    const upsertPendingRequest = React.useCallback((request: PluginPermissionPendingGrantRequest) => {
        if (!params.enabled) return;
        setScopedState((current) => current.scopeKey === scopeKey
            ? { scopeKey, state: upsertPluginPermissionPendingRequest(current.state, request) }
            : current);
    }, [params.enabled, scopeKey]);

    const hasGrant = React.useCallback((input: Partial<PluginPermissionGrantIdentity>) => {
        return hasPluginPermissionGrant(state, input);
    }, [state]);

    const pendingRequests = React.useMemo(
        () => selectPluginPermissionPendingRequests(state),
        [state],
    );

    return React.useMemo(() => ({
        state,
        pendingRequests,
        hasGrant,
        refresh,
        grant,
        revoke,
        dismissRequest,
        upsertPendingRequest,
    }), [
        dismissRequest,
        grant,
        hasGrant,
        pendingRequests,
        refresh,
        revoke,
        state,
        upsertPendingRequest,
    ]);
}
