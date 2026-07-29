import {
    buildBackendTargetKeyV2,
    readBackendTargetRefV2,
    type BackendTargetKeyV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

export function formatBackendTargetKeyV2(target: BackendTargetRefV2): BackendTargetKeyV2 {
    return buildBackendTargetKeyV2(target);
}

export function resolveBackendTargetKeyV2(input: BackendTargetRefV2Input): BackendTargetKeyV2 {
    return formatBackendTargetKeyV2(readBackendTargetRefV2(input));
}

export function backendTargetsMatch(a: BackendTargetRefV2Input, b: BackendTargetRefV2Input): boolean {
    return resolveBackendTargetKeyV2(a) === resolveBackendTargetKeyV2(b);
}
