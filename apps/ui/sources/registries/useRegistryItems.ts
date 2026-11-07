import * as React from 'react';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryKindV1, type RegistryListPageV1 } from '@happier-dev/protocol/registries';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useRegistryActionRead } from './useRegistryActionRead';
import { describeRegistrySourceStatus } from './describeRegistrySourceStatus';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';
import { admitRegistrySummaryMark, type RegistryCatalogItemSummary } from './registryBrandMark';
import type { RegistryContributionFamilyV1 } from '@happier-dev/protocol/registries';

type DisplayPage = Omit<RegistryListPageV1, 'items'> & Readonly<{ items: RegistryCatalogItemSummary[] }>;
type CurationPage = Readonly<{ sourceId: string; discovery: NonNullable<DisplayPage['discovery']> }>;
const parse = (value: unknown, previous: readonly DisplayPage[] = [], previousCuration: readonly CurationPage[] = []) => {
    const parsed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(value);
    const priorPages = new Map(previous.map(page => [page.sourceId, page]));
    const sources = new Map(previous.map(page => [page.sourceId, new Map(page.items.map(item => [item.itemId, item]))]));
    const pages = parsed.pages.map(page => ({ ...page,
        ...(page.status.state !== 'ok' && page.status.state !== 'invalid_source' && priorPages.get(page.sourceId)?.discovery
            ? { discovery: priorPages.get(page.sourceId)!.discovery } : {}),
        ...(page.discovery ? { discovery: (() => {
            const prior = priorPages.get(page.sourceId)?.discovery;
            if (!prior) return page.discovery;
            if (sameStrictJsonValue(prior, page.discovery)) return prior;
            const byId = new Map(prior.items.map(item => [item.id, item]));
            return { ...page.discovery, items: page.discovery.items.map(item => {
                const previousItem = byId.get(item.id);
                return previousItem && sameStrictJsonValue(previousItem, item) ? previousItem : item;
            }), categories: sameStrictJsonValue(prior.categories, page.discovery.categories) ? prior.categories : page.discovery.categories,
            jobs: sameStrictJsonValue(prior.jobs, page.discovery.jobs) ? prior.jobs : page.discovery.jobs };
        })() } : {}),
        items: page.items.map(item => {
            const prior = sources.get(page.sourceId)?.get(item.itemId);
            if (prior) {
                const { brandMark: _mark, ...summary } = prior;
                if (sameStrictJsonValue(summary, item)) return prior;
            }
            return admitRegistrySummaryMark(item, prior);
        }) }));
    const priorCurationBySource = new Map(previousCuration.map(page => [page.sourceId, page]));
    const curation = pages.flatMap(page => {
        if (!page.discovery) return [];
        const prior = priorCurationBySource.get(page.sourceId);
        return [prior?.discovery === page.discovery ? prior : { sourceId: page.sourceId, discovery: page.discovery }];
    });
    return { ...parsed, pages, curation: curation.length === previousCuration.length
        && curation.every((page, index) => page === previousCuration[index]) ? previousCuration : curation };
};
const EMPTY_PAGES: readonly DisplayPage[] = [];
const EMPTY_CURATION: readonly CurationPage[] = [];
export function useRegistryItems(input: { kind: RegistryKindV1; sourceIds?: readonly string[]; query?: string;
    contributionFamily?: RegistryContributionFamilyV1 }, enabled = true) {
    const revision = useRegistrySourceRevision(enabled, input.sourceIds);
    const [more, setMore] = React.useState<{ first: ReturnType<typeof parse> | null; pages: readonly DisplayPage[] } | null>(null);
    const pagesFor = (value: ReturnType<typeof parse> | null) => value && more?.first === value ? more.pages : value?.pages;
    const read = useRegistryActionRead('registries.items.list', input, (value, previous: ReturnType<typeof parse> | null) => {
        const previousPages = pagesFor(previous);
        const parsed = parse(value, previousPages, previous?.curation);
        // A fresh first page supersedes a failed following page even if its unchanged
        // payload retains identity. Healthy pagination survives an ordinary reopen.
        if (more?.first === previous && more.pages.some(page => page.status.state !== 'ok')) setMore(null);
        if (!previousPages) return parsed;
        const bySource = new Map(previousPages.map(page => [page.sourceId, page]));
        return { ...parsed, pages: parsed.pages.map(page => {
            const prior = bySource.get(page.sourceId);
            if (!prior || page.status.state === 'ok' || page.status.state === 'invalid_source') return page;
            // An outage is not an empty catalog. Retain only this exact read's
            // source items, while the failure remains visible and cannot page.
            return { ...page, items: prior.items, nextCursor: null };
        }) };
    }, revision, enabled, { sourceIds: input.sourceIds, failures: value => pagesFor(value) ?? EMPTY_PAGES });
    const pages = pagesFor(read.value) ?? EMPTY_PAGES;
    // Loading/error publications do not change catalog content. Keep this
    // producer's array stable while the same admitted pages remain displayed.
    const items = React.useMemo(() => pages.flatMap(page => page.items), [pages]);
    const paging = React.useRef(false);
    const nextPage = React.useCallback(async () => {
        if (paging.current) return;
        paging.current = true;
        const first = read.value;
        try {
            const following = await Promise.all(pages.filter(page => page.nextCursor !== null).map(async page => {
                const result = await read.execution.execute('registries.items.list', { ...input, sourceIds: [page.sourceId], cursor: page.nextCursor });
                if (!result.ok) throw new Error(result.error);
                return parse(result.result, pages).pages;
            }));
            if (!read.execution.isCurrent()) return;
            const bySource = new Map(following.flat().map(page => [page.sourceId, page]));
            setMore({ first, pages: pages.map(page => {
                const next = bySource.get(page.sourceId);
                if (!next) return page;
                const items = new Map(page.items.map(item => [item.itemId, item]));
                for (const item of next.items) items.set(item.itemId, item);
                return { ...next, items: [...items.values()] };
            }) });
        } finally { paging.current = false; }
    }, [input.kind, JSON.stringify(input.sourceIds), input.query, input.contributionFamily, pages, read.execution.execute, read.execution.isCurrent, read.value]);
    const curation = read.value?.curation ?? EMPTY_CURATION;
    return React.useMemo(() => ({ items, pages, curation, loading: read.loading, stale: read.stale,
        sourceRevision: revision,
        error: read.error, status: read.status, nextPage, hasNextPage: pages.some(page => page.nextCursor !== null), refresh: read.refresh,
        sourceFailures: pages.flatMap(page => page.status.state === 'ok' ? [] : [{ sourceId: page.sourceId,
            status: page.status, message: describeRegistrySourceStatus(page.status), onRetry: read.refresh }]),
    }), [items, pages, curation, revision, read.loading, read.stale, read.error, read.status, nextPage, read.refresh]);
}
