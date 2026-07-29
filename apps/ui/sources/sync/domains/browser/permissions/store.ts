import type {
    BrowserPermissionDecisionV1,
    BrowserPermissionGrantV1,
    BrowserPermissionRequestV1,
} from '@happier-dev/protocol';

export type BrowserPermissionsState = Readonly<{
    grantsById: Readonly<Record<string, BrowserPermissionGrantV1>>;
    requestsById: Readonly<Record<string, BrowserPermissionRequestV1>>;
    decisionsById: Readonly<Record<string, BrowserPermissionDecisionV1>>;
}>;

export function createBrowserPermissionsState(): BrowserPermissionsState {
    return {
        grantsById: {},
        requestsById: {},
        decisionsById: {},
    };
}

export function upsertBrowserPermissionGrant(
    state: BrowserPermissionsState,
    grant: BrowserPermissionGrantV1,
): BrowserPermissionsState {
    return {
        ...state,
        grantsById: {
            ...state.grantsById,
            [grant.id]: grant,
        },
    };
}

export function upsertBrowserPermissionRequest(
    state: BrowserPermissionsState,
    request: BrowserPermissionRequestV1,
): BrowserPermissionsState {
    return {
        ...state,
        requestsById: {
            ...state.requestsById,
            [request.permissionRequestId]: request,
        },
    };
}

export function upsertBrowserPermissionDecision(
    state: BrowserPermissionsState,
    decision: BrowserPermissionDecisionV1,
): BrowserPermissionsState {
    return {
        ...state,
        decisionsById: {
            ...state.decisionsById,
            [decision.decisionId]: decision,
        },
    };
}

export function dropBrowserPermissionsForProfiles(
    state: BrowserPermissionsState,
    profileIds: ReadonlySet<string>,
): BrowserPermissionsState {
    const grantsById: Record<string, BrowserPermissionGrantV1> = {};
    for (const grant of Object.values(state.grantsById)) {
        if (grant.profileId && profileIds.has(grant.profileId)) continue;
        grantsById[grant.id] = grant;
    }

    const requestsById: Record<string, BrowserPermissionRequestV1> = {};
    for (const request of Object.values(state.requestsById)) {
        if (profileIds.has(request.profileId)) continue;
        requestsById[request.permissionRequestId] = request;
    }

    const decisionsById: Record<string, BrowserPermissionDecisionV1> = {};
    for (const decision of Object.values(state.decisionsById)) {
        if (profileIds.has(decision.profileId)) continue;
        decisionsById[decision.decisionId] = decision;
    }

    return { grantsById, requestsById, decisionsById };
}
