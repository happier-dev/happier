import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';

export function resolveResumePickerBackendTarget(params: Readonly<{
    tempBackendTarget?: BackendTargetRefV2 | null;
    routeBackendTarget?: BackendTargetRefV2 | null;
    availableBackendTargets?: ReadonlyArray<BackendTargetRefV2>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
}>): BackendTargetRefV2 {
    return resolvePreferredBackendTarget({
        candidateBackendTargets: [params.tempBackendTarget, params.routeBackendTarget],
        availableBackendTargets: params.availableBackendTargets,
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
    });
}
