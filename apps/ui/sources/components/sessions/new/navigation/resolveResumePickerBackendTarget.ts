import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';

export function resolveResumePickerBackendTarget(params: Readonly<{
    tempBackendTarget?: PersistedBackendTargetRefV2 | null;
    routeBackendTarget?: PersistedBackendTargetRefV2 | null;
    availableBackendTargets?: ReadonlyArray<PersistedBackendTargetRefV2>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
}>): PersistedBackendTargetRefV2 {
    return resolvePreferredBackendTarget({
        candidateBackendTargets: [params.tempBackendTarget, params.routeBackendTarget],
        availableBackendTargets: params.availableBackendTargets,
        lastUsedAgent: params.lastUsedAgent,
        lastUsedBackendTarget: params.lastUsedBackendTarget,
    });
}
