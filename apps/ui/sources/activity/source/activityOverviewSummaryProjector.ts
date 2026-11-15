import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';

import { createActivitySourceAddressTable } from './activitySourceSessionAddresses';
import {
    areActivitySummaryFactsEqual,
    forEachActivitySummaryCandidate,
    readActivitySummaryFacts,
    type ActivityOverviewSummary,
    type ActivitySummaryFacts,
} from './buildActivityOverviewFromSource';
import type { ActivitySourceProjector } from './sharedActivitySourceProjection';

export type ActivityOverviewSummaryProjectorOptions = Readonly<{
    /** Exact-Home policy; a Home answering `null` contributes nothing (the badge's per-Home channel). */
    resolveSessionOptionsForServerId?: (serverId: string) => SessionAttentionOptions | null;
    /** Count opened-transcript pending evidence (the badge), not only list facts. */
    includeHydratedMessages?: boolean;
}>;

/**
 * The summary's per-address table: a Session row write re-classifies that address and moves the
 * totals by its difference, so the work follows the changed rows rather than the corpus.
 */
export function createActivityOverviewSummaryProjector(
    options: ActivityOverviewSummaryProjectorOptions = {},
): ActivitySourceProjector<ActivityOverviewSummary> {
    let totalAttentionCount = 0;
    let inboxContentCount = 0;
    let inboxNeedsYouCount = 0;
    let workingCount = 0;
    let needsYouCount = 0;
    // Entries holding the current soonest boundary; only losing one of them needs a rescan.
    let boundary: { ms: number | null; holders: number } = { ms: null, holders: 0 };
    let nowMs = Date.now();
    const count = (facts: ActivitySummaryFacts, sign: 1 | -1) => {
        if (facts.attention) totalAttentionCount += sign;
        if (facts.inbox) inboxContentCount += sign;
        if (facts.inboxNeedsYou) inboxNeedsYouCount += sign;
        if (facts.working) workingCount += sign;
        if (facts.needsYou) needsYouCount += sign;
    };
    let boundaryStale = false;
    const table = createActivitySourceAddressTable<ActivitySummaryFacts>({
        includeWarmSourceWhenNotReady: true,
        classify: (source, addresses) => {
            const facts = new Map<string, ActivitySummaryFacts>();
            forEachActivitySummaryCandidate({ source, nowMs, includeWarmSourceWhenNotReady: true, addresses,
                resolveSessionOptionsForServerId: options.resolveSessionOptionsForServerId,
                includeHydratedMessages: options.includeHydratedMessages }, (visited) => {
                facts.set(sessionAddressKey(visited.entry.address), readActivitySummaryFacts(visited, nowMs));
            });
            return facts;
        },
        isSame: areActivitySummaryFactsEqual,
        onChange: (_key, previous, next) => {
            if (previous) {
                count(previous, -1);
                if (previous.nextAttentionBoundaryMs !== null && previous.nextAttentionBoundaryMs === boundary.ms) {
                    boundary.holders -= 1;
                    if (boundary.holders === 0) boundaryStale = true;
                }
            }
            if (next) {
                count(next, 1);
                const ms = next.nextAttentionBoundaryMs;
                if (ms !== null && !boundaryStale) {
                    if (boundary.ms === null || ms < boundary.ms) boundary = { ms, holders: 1 };
                    else if (ms === boundary.ms) boundary.holders += 1;
                }
            }
        },
    });
    let published: ActivityOverviewSummary | undefined;
    return {
        project: ({ source, nowMs: projectedAtMs, state }) => {
            nowMs = projectedAtMs;
            const changed = table.update(source, state);
            if (boundaryStale) {
                boundaryStale = false;
                boundary = { ms: null, holders: 0 };
                for (const facts of table.entries().values()) {
                    const ms = facts.nextAttentionBoundaryMs;
                    if (ms === null) continue;
                    if (boundary.ms === null || ms < boundary.ms) boundary = { ms, holders: 1 };
                    else if (ms === boundary.ms) boundary.holders += 1;
                }
            }
            if (published && !changed && published.isDataReady === source.isDataReady) return published;
            published = { isDataReady: source.isDataReady, totalAttentionCount, inboxContentCount, inboxNeedsYouCount,
                nextAttentionBoundaryMs: boundary.ms, workingCount, needsYouCount };
            return published;
        },
        observeUnchangedSource: state => table.observeUnchangedSource(state),
    };
}
