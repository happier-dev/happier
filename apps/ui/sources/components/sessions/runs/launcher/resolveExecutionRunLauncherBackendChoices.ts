import { buildBackendTargetKey, type AcpCatalogSettingsV1, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { getAgentCore } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries, resolveBuiltInAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildAvailableReviewEngineOptions, type ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

export type ExecutionRunLauncherBackendChoice = Readonly<{
    target: BackendTargetRefV1;
    targetKey: string;
    builtInAgentId: string;
    title: string;
    disabled: boolean;
}>;

function isResolvableBuiltInCatalogAgent(id: string): boolean {
    try {
        getAgentCore(id as any);
        return true;
    } catch {
        return false;
    }
}

export function resolveExecutionRunLauncherBackendChoices(params: Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    intent: string;
}>): readonly ExecutionRunLauncherBackendChoice[] {
    const catalogAgentIds = Array.from(
        new Set([
            ...params.enabledAgentIds,
            ...Object.keys(params.executionRunsBackends ?? {}),
        ]),
    ).filter((id) => isResolvableBuiltInCatalogAgent(id));
    const availableBuiltInBackendIds = new Set(
        resolveExecutionRunAvailableBackends(params.executionRunsBackends, params.intent),
    );

    if (params.intent === 'review') {
        return buildAvailableReviewEngineOptions({
            enabledAgentIds: [...params.enabledAgentIds],
            executionRunsBackends: params.executionRunsBackends,
            resolveAgentLabel: (id) => id,
        }).map((option) => {
            const target: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: option.id };
            return {
                target,
                targetKey: buildBackendTargetKey(target),
                builtInAgentId: option.id,
                title: option.id,
                disabled: option.disabled === true,
            };
        });
    }

    return getResolvedBackendCatalogEntries({
        enabledAgentIds: catalogAgentIds as any,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
    }).map((entry) => {
        const builtInAgentId = resolveBuiltInAgentIdForBackendTarget(entry.target);
        return {
            target: entry.target,
            targetKey: entry.targetKey,
            builtInAgentId,
            title: entry.family === 'configuredAcpBackend' ? entry.title : builtInAgentId,
            disabled: !availableBuiltInBackendIds.has(builtInAgentId),
        };
    });
}
