import type { TriageEntryRefV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginError, type JsonValue, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { parseTriageSearchQuery, projectTriageEntrySearchText, triageEntryMatchesSearch } from '../../projection/entrySearch.js';
import {
    TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
    TriageLinkEntryToSessionActionResultV1Schema,
    TriageLinkEntryToSessionInputV1Schema,
    type TriageLinkEntryToSessionActionResultV1,
    type TriageSourceSessionLinksLaneV1,
} from '../../actions/sessionLinksProtocol.js';
import { projectTriageSessionLinkedEntrySummaries, type TriageSessionLinkedEntrySummaryV1, type TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';

export type TriageSessionLinkedEntryCandidateV1 = Readonly<{ entry: TriageSessionLinkedEntrySummaryV1; alreadyLinked: boolean }>;

export function hasReadableTriageSessionLinkCoverageV1(lane: TriageSourceSessionLinksLaneV1): boolean {
    return lane.kindIds !== undefined && (lane.health.kind === 'complete' || lane.health.kind === 'partial');
}

export function projectTriageSessionLinkedEntryCandidates(
    rows: readonly TriageListRowV1[],
    query: string,
    linked: readonly TriageEntryRefV1[],
    workflowSubject: (entryRef: TriageEntryRefV1) => TriageSourceWorkflowSubjectV1 | null,
    summaryBaseline?: TriageSessionLinkedEntrySummaryBaselineV1,
    previous?: readonly TriageSessionLinkedEntryCandidateV1[],
    sourceHealth?: readonly TriageSourceSessionLinksLaneV1[],
): readonly TriageSessionLinkedEntryCandidateV1[] {
    const terms = parseTriageSearchQuery(query);
    const linkedKeys = new Set(linked.map(triageEntryRowKey));
    const summaries = projectTriageSessionLinkedEntrySummaries(rows, workflowSubject, summaryBaseline);
    const prior = new Map(previous?.map(candidate => [triageEntryRowKey(candidate.entry.entryRef), candidate]));
    // A complete slice proves absence only for its exact source, instance and
    // kind. Failed or unknown sibling coverage must never become "not linked".
    const scopes = new Map<string, { complete: Set<string>; failed: Set<string>; unavailable: Set<string>; unknown: boolean }>();
    const scopeKey = (source: TriageEntryRefV1['source'], instance: string) => JSON.stringify([source.pluginId, source.localId, instance]);
    for (const lane of sourceHealth ?? []) {
        const key = scopeKey(lane.source, lane.sourceInstanceId);
        const scope = scopes.get(key) ?? { complete: new Set<string>(), failed: new Set<string>(), unavailable: new Set<string>(), unknown: false };
        if (lane.kindIds === undefined) scope.unknown = true;
        else for (const kind of lane.kindIds) (hasReadableTriageSessionLinkCoverageV1(lane) ? scope.complete : scope.failed).add(kind);
        if (lane.health.kind === 'partial') for (const ref of lane.health.unavailableRefs) scope.unavailable.add(triageEntryRowKey(ref));
        scopes.set(key, scope);
    }
    const candidates = rows.flatMap((row) => {
        if (!triageEntryMatchesSearch(projectTriageEntrySearchText(row.observations), terms)) return [];
        const entry = summaries.get(triageEntryRowKey(row.entryRef)) ?? null;
        if (entry === null) return [];
        if (sourceHealth !== undefined) {
            const coverage = entry.sourceInstanceId === null ? undefined : scopes.get(scopeKey(entry.entryRef.source, entry.sourceInstanceId));
            if (!coverage || coverage.unknown || !coverage.complete.has(entry.entryRef.kindId) || coverage.failed.has(entry.entryRef.kindId)
                || coverage.unavailable.has(triageEntryRowKey(entry.entryRef))) return [];
        }
        const key = triageEntryRowKey(row.entryRef);
        const alreadyLinked = linkedKeys.has(key);
        const retained = prior.get(key);
        return [retained?.entry === entry && retained.alreadyLinked === alreadyLinked
            ? retained : Object.freeze({ entry, alreadyLinked })];
    });
    return previous !== undefined && candidates.length === previous.length
        && candidates.every((candidate, index) => candidate === previous[index]) ? previous : Object.freeze(candidates);
}

export async function linkTriageSessionEntry(
    host: Readonly<{ executeAction(action: string, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown> }>,
    sessionId: string,
    entry: TriageSessionLinkedEntrySummaryV1,
    options?: PluginCancellationOptions,
): Promise<TriageLinkEntryToSessionActionResultV1> {
    try {
        const input = TriageLinkEntryToSessionInputV1Schema.parse({
            v: 1, sessionId, entryRef: entry.entryRef,
            ...(entry.sourceInstanceId === null ? {} : { sourceInstanceId: entry.sourceInstanceId }),
            display: { locator: entry.locator, scopeLabel: entry.scopeLabel },
        });
        return TriageLinkEntryToSessionActionResultV1Schema.parse(await host.executeAction(
            TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
            input,
            options,
        ));
    } catch (error) {
        if (isPluginError(error)) throw error;
        return Object.freeze({ v: 1, status: 'failed' });
    }
}
