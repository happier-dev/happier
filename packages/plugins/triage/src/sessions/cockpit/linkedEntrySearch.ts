import type { TriageEntryRefV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginError, type JsonValue, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { parseTriageSearchQuery, projectTriageEntrySearchText, triageEntryMatchesSearch } from '../../projection/entrySearch.js';
import {
    TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
    TriageLinkEntryToSessionActionResultV1Schema,
    TriageLinkEntryToSessionInputV1Schema,
    type TriageLinkEntryToSessionActionResultV1,
} from '../../actions/sessionLinksProtocol.js';
import { projectTriageSessionLinkedEntrySummary, type TriageSessionLinkedEntrySummaryV1 } from './linkedEntrySummary.js';

export type TriageSessionLinkedEntryCandidateV1 = Readonly<{ entry: TriageSessionLinkedEntrySummaryV1; alreadyLinked: boolean }>;

export function projectTriageSessionLinkedEntryCandidates(
    rows: readonly TriageListRowV1[],
    query: string,
    linked: readonly TriageEntryRefV1[],
    workflowSubject: (entryRef: TriageEntryRefV1) => TriageSourceWorkflowSubjectV1 | null,
): readonly TriageSessionLinkedEntryCandidateV1[] {
    const terms = parseTriageSearchQuery(query);
    const linkedKeys = new Set(linked.map(triageEntryRowKey));
    return Object.freeze(rows.flatMap((row) => {
        if (!triageEntryMatchesSearch(projectTriageEntrySearchText(row.observations), terms)) return [];
        const entry = projectTriageSessionLinkedEntrySummary(row, workflowSubject(row.entryRef));
        return entry === null ? [] : [Object.freeze({ entry, alreadyLinked: linkedKeys.has(triageEntryRowKey(row.entryRef)) })];
    }));
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
