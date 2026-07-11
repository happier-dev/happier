import {
    buildBackendTargetKey,
    convertBackendTargetRefV2ToV1,
    readLegacyConfiguredAcpBackendId,
    type AcpCatalogSettingsV1,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import {
    getResolvedBackendCatalogEntries,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import {
    LEGACY_COMPAT_PRIMARY_AGENT_ID,
} from '@/agents/backendCatalog/legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildAvailableReviewEngineOptions, type ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

export type ExecutionRunLauncherBackendChoice = Readonly<{
    backendTarget: BackendTargetRefV2;
    targetKey: string;
    backendId: string;
    title: string;
    disabled: boolean;
}>;

type ResolvedBackendCatalogEntry = ReturnType<typeof getResolvedBackendCatalogEntries>[number];

function collapseConfiguredAcpBackendCollisions(
    entries: readonly ResolvedBackendCatalogEntry[],
): readonly ResolvedBackendCatalogEntry[] {
    const configuredAcpBackendIds = new Set(
        entries
            .filter((entry) => entry.kind === 'configuredBackend')
            .map((entry) => entry.backendId)
            .filter((backendId): backendId is string => typeof backendId === 'string' && backendId.length > 0),
    );

    if (configuredAcpBackendIds.size === 0) {
        return entries;
    }

    return entries.filter((entry) => {
        if (entry.kind === 'configuredBackend') {
            return true;
        }
        return !configuredAcpBackendIds.has(entry.backendId ?? '');
    });
}

function isCanonicalCatalogBackendId(value: string): boolean {
    return value.length > 0 && value !== LEGACY_COMPAT_PRIMARY_AGENT_ID && !readLegacyConfiguredAcpBackendId(value);
}

function hasLegacyCompatExecutionRunAvailabilityCarrier(
    availableBackendIds: ReadonlySet<string>,
    configuredBackendId?: string | null,
): boolean {
    if (availableBackendIds.has(LEGACY_COMPAT_PRIMARY_AGENT_ID)) {
        return true;
    }
    if (!configuredBackendId) {
        return false;
    }
    return Array.from(availableBackendIds).some((backendId) => readLegacyConfiguredAcpBackendId(backendId) === configuredBackendId);
}

function resolveReviewBackendLabel(params: Readonly<{
    backendId: string;
    executionRunBackend?: ExecutionRunsBackendSnapshotEntry | null;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
}>): string {
    const projectedTitle = params.mergedBackendProjectionById?.[params.backendId]?.title;
    if (typeof projectedTitle === 'string' && projectedTitle.trim().length > 0) {
        return projectedTitle;
    }
    return params.executionRunBackend?.title
        ?? params.executionRunBackend?.label
        ?? params.executionRunBackend?.displayName
        ?? params.backendId;
}

export function resolveExecutionRunLauncherBackendChoices(params: Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    intent: string;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): readonly ExecutionRunLauncherBackendChoice[] {
    const catalogBackendIds = Array.from(
        new Set([
            ...params.enabledAgentIds,
            ...Object.keys(params.executionRunsBackends ?? {}),
        ]),
    )
        .map((id) => String(id ?? '').trim())
        .filter(isCanonicalCatalogBackendId);
    const availableBackendIds = new Set(
        resolveExecutionRunAvailableBackends(params.executionRunsBackends, params.intent),
    );

    if (params.intent === 'review') {
        return buildAvailableReviewEngineOptions({
            enabledAgentIds: [...params.enabledAgentIds],
            executionRunsBackends: params.executionRunsBackends,
            resolveAgentLabel: (id) => resolveReviewBackendLabel({
                backendId: id,
                executionRunBackend: params.executionRunsBackends?.[id] ?? null,
                mergedBackendProjectionById: params.mergedBackendProjectionById ?? null,
            }),
        }).map((option) => {
            const target: BackendTargetRefV2 = { kind: 'backend', backendId: option.id };
            return {
                backendTarget: target,
                targetKey: resolveBackendTargetKeyV2(target),
                backendId: option.id,
                title: option.label,
                disabled: option.disabled === true,
            };
        });
    }

    return collapseConfiguredAcpBackendCollisions(getResolvedBackendCatalogEntries({
        enabledAgentIds: catalogBackendIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
        discoveredBackendIds: Object.keys(params.executionRunsBackends ?? {}).map((id) => String(id ?? '').trim()).filter(isCanonicalCatalogBackendId),
        mergedBackendProjectionById: params.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
    })).map((entry) => {
        const backendId = entry.backendId;
        const catalogAgentId = entry.catalogAgentId;
        const isAvailable = entry.kind === 'configuredBackend'
            ? availableBackendIds.has(backendId)
                || (catalogAgentId ? availableBackendIds.has(catalogAgentId) : false)
                || hasLegacyCompatExecutionRunAvailabilityCarrier(availableBackendIds, backendId)
            : availableBackendIds.has(backendId);

        // UI action inputs (and their protocol schemas) still use the legacy target key vocabulary
        // (`agent:*`, `acpBackend:*`) for execution-run launcher surfaces. Keep V2 backend-target
        // identity elsewhere (routes/settings/spawn/resume), but do not push V2 keys into action
        // schemas that do not accept them.
        const legacyTargetKey = buildBackendTargetKey(convertBackendTargetRefV2ToV1(entry.backendTarget) as any);
        return {
            backendTarget: entry.backendTarget,
            targetKey: legacyTargetKey,
            backendId,
            title: entry.title,
            disabled: !isAvailable,
        };
    });
}
