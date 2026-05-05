import {
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { isExecutionRunConcreteBackendTarget } from '@/agent/runtime/bridges/executionRun/backendTargets';

export function normalizeExecutionRunPublicStateBackendTarget(value: unknown): Record<string, unknown> | null {
    try {
        const parsed = readBackendTargetRefV2(value as BackendTargetRefV2Input);
        const normalized = convertBackendTargetRefV2ToV1(parsed);
        return isExecutionRunConcreteBackendTarget(normalized) ? normalized : null;
    } catch {
        return null;
    }
}
