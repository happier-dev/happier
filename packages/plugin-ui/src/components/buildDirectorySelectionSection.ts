import type { SelectionListOption, SelectionListSectionDescriptor } from './shareSelectionListTypes.js';
import type { ShareDirectorySectionModel } from './shareGrantModels.js';

/** Directory snapshots keep their producer's pending state; only settled sources can answer a search. */
export function buildDirectorySelectionSection<TRow>(input: Readonly<{
    loadingLabel: string;
    source: Omit<ShareDirectorySectionModel, 'candidates' | 'resolveCandidates'> & Readonly<{
        candidates: readonly TRow[];
        resolveCandidates?: (query: string, signal: AbortSignal) => Promise<readonly TRow[]>;
    }>;
    id: string;
    title: string;
    resolverKey: string;
    showSkeletonsOnFirstLoad: boolean;
    options: (rows: readonly TRow[], query: string) => readonly SelectionListOption[];
}>): SelectionListSectionDescriptor {
    const { source } = input;
    if (source.status === 'loading' || source.status === 'refreshing') {
        // Root suggestions keep unknown headings out, as on their dynamic first frame.
        return { kind: 'static', id: input.id,
            title: input.showSkeletonsOnFirstLoad || source.candidates.length > 0 ? input.title : undefined,
            options: input.options(source.candidates, ''), resultHint: input.loadingLabel };
    }
    return {
        kind: 'dynamic', id: input.id, title: input.title, resolverKey: input.resolverKey,
        resultFiltering: 'provider', resultTransition: 'none',
        showSkeletonsOnFirstLoad: input.showSkeletonsOnFirstLoad, loadingSkeletonRows: 1,
        // SelectionList owns debounce, cancellation and stale result rejection.
        resolve: async (query, signal) => ({ options: input.options(
            source.resolveCandidates ? await source.resolveCandidates(query, signal) : source.candidates, query,
        ) }),
    };
}
