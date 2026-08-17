import type {
    PluginPermissionGrant,
    PluginPermissionGrantApprovedResult,
    PluginPermissionGrantIdentity,
    PluginPermissionGrantListResponse,
    PluginPermissionGrantRequestDismissedResult,
    PluginPermissionGrantRevokedResult,
    PluginPermissionPendingGrantRequest,
} from './types';
import { pluginPermissionGrantScopeKey } from './types';

export type PluginPermissionGrantStateStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export type PluginPermissionGrantState = Readonly<{
    grantsById: Readonly<Record<string, PluginPermissionGrant>>;
    grantIds: readonly string[];
    pendingRequestsById: Readonly<Record<string, PluginPermissionPendingGrantRequest>>;
    pendingRequestIds: readonly string[];
    status: PluginPermissionGrantStateStatus;
    error: string | null;
}>;

export function createEmptyPluginPermissionGrantState(): PluginPermissionGrantState {
    return {
        grantsById: {},
        grantIds: [],
        pendingRequestsById: {},
        pendingRequestIds: [],
        status: 'idle',
        error: null,
    };
}

function hasRows(state: PluginPermissionGrantState): boolean {
    return state.grantIds.length > 0 || state.pendingRequestIds.length > 0;
}

export function beginPluginPermissionGrantRefresh(state: PluginPermissionGrantState): PluginPermissionGrantState {
    return {
        ...state,
        status: hasRows(state) ? 'refreshing' : 'loading',
        error: null,
    };
}

export function markPluginPermissionGrantRefreshFailed(
    state: PluginPermissionGrantState,
    error: string,
): PluginPermissionGrantState {
    return {
        ...state,
        status: 'error',
        error,
    };
}

export function applyPluginPermissionGrantList(
    _state: PluginPermissionGrantState,
    response: PluginPermissionGrantListResponse,
): PluginPermissionGrantState {
    const grantsById: Record<string, PluginPermissionGrant> = {};
    const grantIds: string[] = [];
    for (const grant of response.grants) {
        if (grant.status !== 'active') continue;
        grantsById[grant.id] = grant;
        grantIds.push(grant.id);
    }

    const pendingRequestsById: Record<string, PluginPermissionPendingGrantRequest> = {};
    const pendingRequestIds: string[] = [];
    for (const request of response.pendingRequests) {
        if (request.status !== 'pending') continue;
        pendingRequestsById[request.id] = request;
        pendingRequestIds.push(request.id);
    }

    return {
        grantsById,
        grantIds,
        pendingRequestsById,
        pendingRequestIds,
        status: 'ready',
        error: null,
    };
}

function removeId(ids: readonly string[], id: string): readonly string[] {
    return ids.filter((candidate) => candidate !== id);
}

export function upsertPluginPermissionPendingRequest(
    state: PluginPermissionGrantState,
    request: PluginPermissionPendingGrantRequest,
): PluginPermissionGrantState {
    const exists = Object.prototype.hasOwnProperty.call(state.pendingRequestsById, request.id);
    return {
        ...state,
        pendingRequestsById: {
            ...state.pendingRequestsById,
            [request.id]: request,
        },
        pendingRequestIds: exists ? state.pendingRequestIds : [...state.pendingRequestIds, request.id],
    };
}

export function applyPluginPermissionGrantApproved(
    state: PluginPermissionGrantState,
    result: PluginPermissionGrantApprovedResult,
): PluginPermissionGrantState {
    const requestId = result.pendingRequest.id;
    const { [requestId]: _removed, ...pendingRequestsById } = state.pendingRequestsById;
    const grantExists = Object.prototype.hasOwnProperty.call(state.grantsById, result.grant.id);
    const nextGrantsById = result.grant.status === 'active'
        ? {
              ...state.grantsById,
              [result.grant.id]: result.grant,
          }
        : state.grantsById;
    return {
        ...state,
        grantsById: nextGrantsById,
        grantIds: grantExists || result.grant.status !== 'active' ? state.grantIds : [...state.grantIds, result.grant.id],
        pendingRequestsById,
        pendingRequestIds: removeId(state.pendingRequestIds, requestId),
    };
}

export function applyPluginPermissionGrantRevoked(
    state: PluginPermissionGrantState,
    result: PluginPermissionGrantRevokedResult,
): PluginPermissionGrantState {
    const { [result.grant.id]: _removed, ...grantsById } = state.grantsById;
    return {
        ...state,
        grantsById,
        grantIds: removeId(state.grantIds, result.grant.id),
    };
}

export function applyPluginPermissionGrantRequestDismissed(
    state: PluginPermissionGrantState,
    result: PluginPermissionGrantRequestDismissedResult,
): PluginPermissionGrantState {
    const { [result.pendingRequest.id]: _removed, ...pendingRequestsById } = state.pendingRequestsById;
    return {
        ...state,
        pendingRequestsById,
        pendingRequestIds: removeId(state.pendingRequestIds, result.pendingRequest.id),
    };
}

function matchesIdentity(
    value: PluginPermissionGrantIdentity,
    filters: Partial<PluginPermissionGrantIdentity>,
): boolean {
    if (filters.pluginId && value.pluginId !== filters.pluginId) return false;
    if (filters.capability && value.capability !== filters.capability) return false;
    if (
        Object.prototype.hasOwnProperty.call(filters, 'targetScope')
        && !targetScopeMatches(value.targetScope, filters.targetScope)
    ) {
        return false;
    }
    if (
        Object.prototype.hasOwnProperty.call(filters, 'subject')
        && JSON.stringify(value.subject ?? null) !== JSON.stringify(filters.subject ?? null)
    ) {
        return false;
    }
    return true;
}

function targetScopeMatches(
    valueScope: PluginPermissionGrantIdentity['targetScope'],
    filterScope: PluginPermissionGrantIdentity['targetScope'],
): boolean {
    if (!filterScope) return !valueScope;
    if (!valueScope) return false;
    return pluginPermissionGrantScopeKey(valueScope) === pluginPermissionGrantScopeKey(filterScope);
}

export function selectPluginPermissionPendingRequests(
    state: PluginPermissionGrantState,
    filters: Partial<PluginPermissionGrantIdentity> = {},
): readonly PluginPermissionPendingGrantRequest[] {
    return state.pendingRequestIds
        .map((id) => state.pendingRequestsById[id])
        .filter((request): request is PluginPermissionPendingGrantRequest => Boolean(request))
        .filter((request) => matchesIdentity(request, filters))
        .sort((left, right) => right.createdAt - left.createdAt);
}

export function hasPluginPermissionGrant(
    state: PluginPermissionGrantState,
    input: Partial<PluginPermissionGrantIdentity>,
): boolean {
    return state.grantIds
        .map((id) => state.grantsById[id])
        .filter((grant): grant is PluginPermissionGrant => Boolean(grant))
        .some((grant) => matchesIdentity(grant, input));
}
