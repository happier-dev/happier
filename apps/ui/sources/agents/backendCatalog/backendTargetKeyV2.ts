import {
    BackendTargetKeyV2Schema,
    PersistedBackendTargetRefV2Schema,
    buildBackendTargetKeyV2,
    readBackendTargetRefV2,
    type BackendTargetKeyV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

export function formatBackendTargetKeyV2(target: PersistedBackendTargetRefV2): BackendTargetKeyV2 {
    return buildBackendTargetKeyV2(target);
}

export function resolveBackendTargetKeyV2(input: BackendTargetRefV2Input): BackendTargetKeyV2 {
    const canonicalTarget = PersistedBackendTargetRefV2Schema.safeParse(input);
    if (canonicalTarget.success) return formatBackendTargetKeyV2(canonicalTarget.data);
    const canonicalKey = BackendTargetKeyV2Schema.safeParse(input);
    if (canonicalKey.success) return canonicalKey.data;
    return formatBackendTargetKeyV2(readBackendTargetRefV2(input));
}

export function backendTargetsMatch(a: BackendTargetRefV2Input, b: BackendTargetRefV2Input): boolean {
    return resolveBackendTargetKeyV2(a) === resolveBackendTargetKeyV2(b);
}
