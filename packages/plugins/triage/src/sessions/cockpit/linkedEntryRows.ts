import type { TriageEntryRefV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui';

import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageSessionLinkedEntrySummaries, type TriageSessionLinkedEntrySummaryV1, type TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';
import type { TriageSourceSessionLinkV1 } from '../sourceSessionRelations.js';
import type { SessionPullRequestRelations } from '../sessionLinksResource.js';
import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import { projectTriageUnavailableLinkSources, type TriageUnavailableLinkSourceV1 } from './linkedEntrySourceHealth.js';
export type { TriageSessionLinkedEntrySummaryV1 } from './linkedEntrySummary.js';

export type TriageSessionLinkedEntryPresentationV1 =
    | Readonly<{ kind: 'reading' }>
    | Readonly<{ kind: 'linked'; displayPath: string; entryRef: TriageEntryRefV1; entry: TriageSessionLinkedEntrySummaryV1 | null }>
    | Readonly<{ kind: 'nativePullRequest'; displayPath: string; url?: string }>
    | Readonly<{ kind: 'unlinked' }>
    | Readonly<{ kind: 'unreadable' }>;

export type TriageSessionLinkedEntryRowV1 = Readonly<{
    key: string;
    linkedAtMs: number;
    presentation: TriageSessionLinkedEntryPresentationV1;
}>;

/**
 * What could not be read, named. `sources` is empty when the relation read failed as a whole and no lane
 * says which source; a reader is then told only that the links could not be read.
 */
export type TriageSessionLinkedEntriesNoticeV1 = Readonly<{
    sources: readonly TriageUnavailableLinkSourceV1[];
    error?: PluginUiResourceProjectionSnapshot<unknown>['error'];
    readFailures?: SessionPullRequestRelations['failures'];
}>;

export type TriageSessionLinkedEntriesViewV1 =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; notice: TriageSessionLinkedEntriesNoticeV1 }>
    | Readonly<{ kind: 'empty' }>
    | Readonly<{
        kind: 'linked';
        rows: readonly TriageSessionLinkedEntryRowV1[];
        more: boolean;
        notice: TriageSessionLinkedEntriesNoticeV1 | null;
    }>;

/** Presentation consumes the owner's full relation result and coverage as-is. */
export function projectTriageSessionLinkedEntries(input: Readonly<{
    links: readonly TriageSourceSessionLinkV1[];
    nativePullRequests?: SessionPullRequestRelations['links'];
    status: 'loading' | 'ready' | 'partial' | 'failed';
    lanes?: readonly TriageSourceSessionLinksLaneV1[];
    error?: PluginUiResourceProjectionSnapshot<unknown>['error'];
    readFailures?: SessionPullRequestRelations['failures'];
    entries?: readonly TriageListRowV1[];
    workflowSubject?: (entryRef: TriageEntryRefV1) => TriageSourceWorkflowSubjectV1 | null;
    summaryBaseline?: TriageSessionLinkedEntrySummaryBaselineV1;
    previous?: TriageSessionLinkedEntriesViewV1;
}>): TriageSessionLinkedEntriesViewV1 {
    const failed = input.status === 'partial' || input.status === 'failed';
    const notice: TriageSessionLinkedEntriesNoticeV1 = { sources: projectTriageUnavailableLinkSources(input.lanes),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.readFailures?.length ? { readFailures: input.readFailures } : {}) };
    if (input.links.length === 0 && !input.nativePullRequests?.length) {
        if (failed) return { kind: 'unavailable', notice };
        return input.status === 'ready' ? { kind: 'empty' } : { kind: 'loading' };
    }
    const entries = projectTriageSessionLinkedEntrySummaries(input.entries ?? [], input.workflowSubject ?? (() => null), input.summaryBaseline);
    const prior = input.previous?.kind === 'linked' ? input.previous : undefined;
    const priorRows = new Map(prior?.rows.map(row => [row.key, row]));
    const rows = input.links.map((link): TriageSessionLinkedEntryRowV1 => {
        const key = triageEntryRowKey(link.entryRef);
        const entry = entries.get(key) ?? null;
        const retained = priorRows.get(key);
        if (retained?.linkedAtMs === link.linkedAtMs && retained.presentation.kind === 'linked'
            && retained.presentation.displayPath === link.displayPath && retained.presentation.entry === entry) return retained;
        return { key, linkedAtMs: link.linkedAtMs,
            presentation: { kind: 'linked', displayPath: link.displayPath, entryRef: link.entryRef, entry } };
    });
    // Configured relations supply detail when they name this same forge item.
    // The binding remains visible when the source cannot supply a row.
    if (input.nativePullRequests?.length) {
        const urls = new Set(input.links.flatMap(link => link.locator?.webUrl === undefined ? [] : [link.locator.webUrl.toLowerCase()]));
        for (const { pullRequest, linkedAtMs, repositoryId, url } of input.nativePullRequests) {
            const key = url?.toLowerCase() ?? JSON.stringify([repositoryId, pullRequest.number]);
            if (urls.has(key)) continue;
            urls.add(key);
            const retained = priorRows.get(key);
            const displayPath = `${pullRequest.repository}#${pullRequest.number}`;
            rows.push(retained?.linkedAtMs === linkedAtMs && retained.presentation.kind === 'nativePullRequest'
                && retained.presentation.displayPath === displayPath && retained.presentation.url === url ? retained
                : { key, linkedAtMs, presentation: { kind: 'nativePullRequest', displayPath, ...(url === undefined ? {} : { url }) } });
        }
    }
    rows.sort((left, right) => right.linkedAtMs - left.linkedAtMs
        || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const linkedNotice = failed ? notice : null;
    if (prior !== undefined && sameNotice(prior.notice, linkedNotice) && prior.rows.length === rows.length
        && rows.every((row, index) => row === prior.rows[index])) return prior;
    return { kind: 'linked', rows, more: false, notice: linkedNotice };
}

function sameNotice(left: TriageSessionLinkedEntriesNoticeV1 | null, right: TriageSessionLinkedEntriesNoticeV1 | null): boolean {
    if (left === null || right === null) return left === right;
    return left.error === right.error && left.sources.length === right.sources.length
        && (left.readFailures?.length ?? 0) === (right.readFailures?.length ?? 0)
        && (left.readFailures?.every((failure, index) => {
            const other = right.readFailures?.[index];
            return failure.sessionId === other?.sessionId && failure.code === other.code && failure.requestId === other.requestId;
        }) ?? true)
        && left.sources.every((source, index) => source.label === right.sources[index]!.label
            && source.reason.key === right.sources[index]!.reason.key
            && source.diagnostic?.code === right.sources[index]!.diagnostic?.code
            && source.diagnostic?.requestId === right.sources[index]!.diagnostic?.requestId);
}
