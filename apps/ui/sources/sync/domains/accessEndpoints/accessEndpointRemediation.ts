import type {
    AccessEndpointRemediationAction,
    AccessEndpointRemediationOwnerSurface,
} from './accessEndpointModel';

export function createAccessEndpointRemediationAction(
    ownerSurface: AccessEndpointRemediationOwnerSurface,
    payload?: Readonly<Record<string, unknown>>,
): AccessEndpointRemediationAction {
    return {
        id: ownerSurface,
        label: ownerSurface,
        ownerSurface,
        ...(payload ? { payload } : {}),
    };
}

export function createScopedAccessEndpointRemediationAction(params: Readonly<{
    id: string;
    ownerSurface: AccessEndpointRemediationOwnerSurface;
    payload?: Readonly<Record<string, unknown>>;
}>): AccessEndpointRemediationAction {
    return {
        id: params.id,
        label: params.ownerSurface,
        ownerSurface: params.ownerSurface,
        ...(params.payload ? { payload: params.payload } : {}),
    };
}
