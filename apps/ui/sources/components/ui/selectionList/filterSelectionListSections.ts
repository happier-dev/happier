import { rankOptionsByQuery } from './SelectionListRenderPlan';
import type { SelectionListSectionDescriptor } from './_types';

/**
 * Substring filter across `label` + `subtitle` of every option in every section.
 * Case-insensitive. Preserves section order. Drops empty sections. Returns the
 * original input reference unchanged when the query is empty (so consumers can
 * cheaply skip re-rendering).
 *
 * RUX-1 Issue 1: ranking now uses `rankOptionsByQuery` so prefix matches
 * surface above substring matches above subtitle-only matches. The user-
 * visible bug was that typing "de" in the path picker buried "dev" under
 * ".codex-pr-fixups" because alphabetical sort beat relevance.
 *
 * Phase 2.1 (Lane B) introduces dynamic sections; this filter is for static
 * sections only. Dynamic sections own their own visibility via `visibleWhen`
 * and re-resolve on input change, so they bypass this helper entirely.
 */
export function filterSelectionListSections(
    sections: ReadonlyArray<SelectionListSectionDescriptor>,
    query: string,
): ReadonlyArray<SelectionListSectionDescriptor> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return sections;

    const result: SelectionListSectionDescriptor[] = [];
    for (const section of sections) {
        // Phase 2.1: only static section descriptors carry `options` synchronously.
        // Dynamic sections are resolved by the orchestrator (see
        // `useSelectionListDynamicSections`) into synthesised static descriptors
        // before reaching this filter, so a `kind === 'dynamic'` descriptor here
        // means the orchestrator chose to keep it transparent and we should pass
        // it through unchanged.
        if (section.kind !== 'static') {
            result.push(section);
            continue;
        }
        const matchedOptions = rankOptionsByQuery(
            section.options,
            normalized,
            section.disableSubtitleRanking === true,
        );
        if (matchedOptions.length === 0) continue;
        result.push({
            ...section,
            options: matchedOptions,
        });
    }
    return result;
}
