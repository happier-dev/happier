import { normalizeSessionListHydrationSessionIds } from './sessionListHydrationPriority';

export type SessionListFetchHydrationTelemetrySource =
    | 'direct'
    | 'bootstrapImportedPins'
    | 'legacyImportedPins'
    | 'changesCatchUp';

type SessionListFetchHydrationTelemetryParams = Readonly<{
    mode?: 'replace' | 'append';
    awaitSessionListHydration?: boolean;
    source?: SessionListFetchHydrationTelemetrySource;
    requiredHydrationSessionIds?: readonly string[];
    organizationRequiredSessionIds?: readonly string[];
    explicitPrioritizedSessionIds?: readonly string[];
    runtimePrioritizedSessionIds?: readonly string[];
    prioritizedHydrationSessionIds?: readonly string[];
    activeViewingSessionId?: string | null;
    visibleSessionIds?: readonly string[];
    activeHydrationSessionIds?: readonly string[];
    includeActiveSessionRows?: boolean;
    includeSessionListAttentionRows?: boolean;
}>;

function countIntersection(left: readonly string[], right: readonly string[]): number {
    if (left.length === 0 || right.length === 0) return 0;
    const rightIds = new Set(right);
    let count = 0;
    for (const value of left) {
        if (rightIds.has(value)) count += 1;
    }
    return count;
}

function countSource(source: SessionListFetchHydrationTelemetrySource, expected: SessionListFetchHydrationTelemetrySource): number {
    return source === expected ? 1 : 0;
}

export function buildSessionListFetchHydrationTelemetryFields(
    params: SessionListFetchHydrationTelemetryParams,
): Record<string, number> {
    const source = params.source ?? 'direct';
    const explicitRequiredIds = normalizeSessionListHydrationSessionIds(params.requiredHydrationSessionIds);
    const organizationRequiredIds = normalizeSessionListHydrationSessionIds(params.organizationRequiredSessionIds);
    const requiredIds = normalizeSessionListHydrationSessionIds([
        ...explicitRequiredIds,
        ...organizationRequiredIds,
    ]);
    const explicitPriorityIds = normalizeSessionListHydrationSessionIds(params.explicitPrioritizedSessionIds);
    const runtimePriorityIds = normalizeSessionListHydrationSessionIds(params.runtimePrioritizedSessionIds);
    const priorityIds = normalizeSessionListHydrationSessionIds(params.prioritizedHydrationSessionIds);
    const activeViewingIds = normalizeSessionListHydrationSessionIds(
        params.activeViewingSessionId ? [params.activeViewingSessionId] : [],
    );
    const visibleIds = normalizeSessionListHydrationSessionIds(params.visibleSessionIds);
    const activeHydrationIds = normalizeSessionListHydrationSessionIds(params.activeHydrationSessionIds);

    return {
        append: params.mode === 'append' ? 1 : 0,
        awaitSessionListHydration: params.awaitSessionListHydration === true ? 1 : 0,
        sourceDirect: countSource(source, 'direct'),
        sourceBootstrapImportedPins: countSource(source, 'bootstrapImportedPins'),
        sourceLegacyImportedPins: countSource(source, 'legacyImportedPins'),
        sourceChangesCatchUp: countSource(source, 'changesCatchUp'),
        explicitRequiredIds: explicitRequiredIds.length,
        organizationRequiredIds: organizationRequiredIds.length,
        requiredIds: requiredIds.length,
        requiredOverlapIds: countIntersection(explicitRequiredIds, organizationRequiredIds),
        explicitPriorityIds: explicitPriorityIds.length,
        runtimePriorityIds: runtimePriorityIds.length,
        priorityIds: priorityIds.length,
        priorityOverlapIds: countIntersection(explicitPriorityIds, runtimePriorityIds),
        activeViewingIds: activeViewingIds.length,
        visibleIds: visibleIds.length,
        activeHydrationIds: activeHydrationIds.length,
        includeActiveSessionRows: params.includeActiveSessionRows === true ? 1 : 0,
        includeSessionListAttentionRows: params.includeSessionListAttentionRows === true ? 1 : 0,
    };
}
