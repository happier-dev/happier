import type {
    PluginMarketplaceDiscoverDiagnostic,
    PluginMarketplaceDiscoverSourceStatus,
} from '../readPluginMarketplaceCatalog';
import { describeRegistrySourceFailure, type RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';

/** One technical fact behind an issue, shown only when the reader asks for details. */
export type PluginMarketplaceDiscoverIssueDetail = Readonly<{ code: string; message: string }>;

/**
 * One thing Browse could not fully show: a marketplace source that did not answer or answered late,
 * or the index as a whole. The daemon can report the same source several ways (its freshness, its
 * own diagnostics, a page diagnostic that names it, a repeated code); a reader sees it once.
 */
export type PluginMarketplaceDiscoverIssue = Readonly<{
    /** `source:<id>`, or `index` for diagnostics that name no source. */
    id: string;
    sourceId: string | null;
    sourceTitle: string | null;
    /** False when the source did not answer (unavailable, offline, sign-in, unreadable); true when it is only behind. */
    reachable: boolean;
    /** A top-level finite read failure uses the same typed source presenter as registry shelves. */
    summary?: string;
    details: readonly PluginMarketplaceDiscoverIssueDetail[];
}>;

type IssueDraft = {
    id: string;
    sourceId: string | null;
    sourceTitle: string | null;
    reachable: boolean;
    details: PluginMarketplaceDiscoverIssueDetail[];
    detailKeys: Set<string>;
};

function addDetail(draft: IssueDraft, diagnostic: PluginMarketplaceDiscoverDiagnostic): void {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (draft.detailKeys.has(key)) return;
    draft.detailKeys.add(key);
    draft.details.push({ code: diagnostic.code, message: diagnostic.message });
}

/**
 * The issue rows for Browse: one per source that is not fresh or reported a problem, and one for
 * index-wide diagnostics. Healthy sources produce nothing.
 */
export function buildPluginMarketplaceDiscoverIssues(input: Readonly<{
    sourceStatuses: readonly PluginMarketplaceDiscoverSourceStatus[];
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    readFailure?: Readonly<{ status: RegistryFailureStatus | null; sourceTitle: string | null }>;
}>): PluginMarketplaceDiscoverIssue[] {
    const drafts = new Map<string, IssueDraft>();
    const draftFor = (sourceId: string | null, sourceTitle: string | null): IssueDraft => {
        const id = sourceId === null ? 'index' : `source:${sourceId}`;
        let draft = drafts.get(id);
        if (!draft) {
            draft = { id, sourceId, sourceTitle, reachable: true, details: [], detailKeys: new Set() };
            drafts.set(id, draft);
        }
        if (draft.sourceTitle === null && sourceTitle !== null) draft.sourceTitle = sourceTitle;
        return draft;
    };
    for (const source of input.sourceStatuses) {
        if (source.freshness === 'fresh' && source.diagnostics.length === 0) continue;
        const draft = draftFor(source.id, source.title);
        if (source.freshness !== 'fresh' && source.freshness !== 'stale') draft.reachable = false;
        for (const diagnostic of source.diagnostics) addDetail(draft, diagnostic);
    }
    for (const diagnostic of input.diagnostics) {
        addDetail(draftFor(diagnostic.sourceId, diagnostic.sourceTitle), diagnostic);
    }
    const issues: PluginMarketplaceDiscoverIssue[] = [...drafts.values()].map(({ detailKeys: _detailKeys, ...issue }) => issue);
    if (input.readFailure && issues.length === 0) issues.push({ id: 'index', sourceId: null,
        sourceTitle: input.readFailure.sourceTitle, reachable: false, details: [],
        summary: describeRegistrySourceFailure(input.readFailure.status, input.readFailure.sourceTitle) });
    return issues;
}
