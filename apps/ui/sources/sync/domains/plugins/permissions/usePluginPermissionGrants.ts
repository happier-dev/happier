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
    const [state, setState] = React.useState(createEmptyPluginPermissionGrantState);
    const refreshInputKey = listInputKey(params.listInput);

    const refresh = React.useCallback(async () => {
        if (!params.enabled || !params.listInput) return;
        setState((current) => beginPluginPermissionGrantRefresh(current));
        try {
            const response = await params.actions.list(params.listInput);
            setState((current) => applyPluginPermissionGrantList(current, response));
        } catch (error) {
            setState((current) => markPluginPermissionGrantRefreshFailed(current, errorMessage(error)));
        }
    }, [params.actions, params.enabled, refreshInputKey]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const grant = React.useCallback(async (input: PluginPermissionGrantDecisionInput) => {
        const result = await params.actions.grant(input);
        setState((current) => applyPluginPermissionGrantApproved(current, result));
    }, [params.actions]);

    const revoke = React.useCallback(async (input: PluginPermissionGrantRevokeInput) => {
        const result = await params.actions.revoke(input);
        setState((current) => applyPluginPermissionGrantRevoked(current, result));
    }, [params.actions]);

    const dismissRequest = React.useCallback(async (input: PluginPermissionGrantDecisionInput) => {
        const result = await params.actions.dismissRequest(input);
        setState((current) => applyPluginPermissionGrantRequestDismissed(current, result));
    }, [params.actions]);

    const upsertPendingRequest = React.useCallback((request: PluginPermissionPendingGrantRequest) => {
        setState((current) => upsertPluginPermissionPendingRequest(current, request));
    }, []);

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
