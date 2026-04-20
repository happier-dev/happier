import {
    isSupportedBackendRuntimeAdapterOperationV1,
    type BackendRuntimeAdapterKindV1,
} from '@happier-dev/protocol';

function normalizeBackendRuntimeAdapterOperation(value: unknown): string {
    return String(value ?? '').trim();
}

export function isSupportedBackendRuntimeAdapterOperation(params: Readonly<{
    kind: BackendRuntimeAdapterKindV1;
    operation: string;
}>): boolean {
    return isSupportedBackendRuntimeAdapterOperationV1({
        kind: params.kind,
        operation: normalizeBackendRuntimeAdapterOperation(params.operation),
    });
}

export function buildBackendRuntimeAdapterDispatchKey(params: Readonly<{
    kind: BackendRuntimeAdapterKindV1;
    operation: string;
}>): string {
    return `${params.kind}:${normalizeBackendRuntimeAdapterOperation(params.operation)}`;
}
