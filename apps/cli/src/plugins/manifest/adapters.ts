import {
    isSupportedBackendSurfaceOperationV1,
    type BackendSurfaceKindV1,
} from '@happier-dev/protocol';

function normalizeBackendSurfaceOperation(value: unknown): string {
    return String(value ?? '').trim();
}

export function isSupportedBackendSurfaceOperation(params: Readonly<{
    kind: BackendSurfaceKindV1;
    operation: string;
}>): boolean {
    return isSupportedBackendSurfaceOperationV1({
        kind: params.kind,
        operation: normalizeBackendSurfaceOperation(params.operation),
    });
}

export function buildBackendSurfaceDispatchKey(params: Readonly<{
    kind: BackendSurfaceKindV1;
    operation: string;
}>): string {
    return `${params.kind}:${normalizeBackendSurfaceOperation(params.operation)}`;
}
