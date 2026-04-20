import {
    BackendTargetKeyV2Schema,
    readBackendTargetRefV2,
    type BackendTargetKeyV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

export function formatBackendTargetKeyV2(target: BackendTargetRefV2): BackendTargetKeyV2 {
    const backendId = String(target.backendId ?? '').trim();
    if (!backendId) {
        throw new Error('Expected backendTarget.backendId to be a non-empty string');
    }

    const configuredBackendId = typeof target.configuredBackendId === 'string'
        ? target.configuredBackendId.trim()
        : '';
    const suffix = configuredBackendId ? `:configured:${configuredBackendId}` : '';
    return BackendTargetKeyV2Schema.parse(`backend:${backendId}${suffix}`);
}

export function resolveBackendTargetKeyV2(input: BackendTargetRefV2Input): BackendTargetKeyV2 {
    return formatBackendTargetKeyV2(readBackendTargetRefV2(input));
}

export function backendTargetsMatch(a: BackendTargetRefV2Input, b: BackendTargetRefV2Input): boolean {
    return resolveBackendTargetKeyV2(a) === resolveBackendTargetKeyV2(b);
}
