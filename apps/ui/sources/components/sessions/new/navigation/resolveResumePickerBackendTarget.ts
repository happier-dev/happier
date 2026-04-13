import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromSettings';

export function resolveResumePickerBackendTarget(params: Readonly<{
    tempBackendTarget?: BackendTargetRefV1 | null;
    routeBackendTarget?: BackendTargetRefV1 | null;
    availableBackendTargets?: ReadonlyArray<BackendTargetRefV1>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
}>): BackendTargetRefV1 {
    return resolvePreferredBackendTarget({
        candidateBackendTargets: [params.tempBackendTarget, params.routeBackendTarget],
        availableBackendTargets: params.availableBackendTargets,
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
    });
}
