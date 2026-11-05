import * as React from 'react';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryKindV1, type RegistryListPageV1 } from '@happier-dev/protocol/registries';
import { useRegistryActionRead } from './useRegistryActionRead';
import { describeRegistrySourceStatus } from './describeRegistrySourceStatus';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';

const parse = (value: unknown) => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(value);
const EMPTY_PAGES: readonly RegistryListPageV1[] = [];
export function useRegistryItems(input: { kind: RegistryKindV1; sourceIds?: readonly string[]; query?: string }, enabled = true) {
    const revision = useRegistrySourceRevision(enabled);
    const [more, setMore] = React.useState<{ first: ReturnType<typeof parse> | null; pages: readonly RegistryListPageV1[] } | null>(null);
    const read = useRegistryActionRead('registries.items.list', input, (value, previous: ReturnType<typeof parse> | null) => {
        const parsed = parse(value);
        const previousPages = previous && more?.first === previous ? more.pages : previous?.pages;
        if (!previousPages) return parsed;
        const bySource = new Map(previousPages.map(page => [page.sourceId, page]));
        return { ...parsed, pages: parsed.pages.map(page => {
            const prior = bySource.get(page.sourceId);
            if (!prior || page.status.state === 'ok' || page.status.state === 'invalid_source') return page;
            // An outage is not an empty catalog. Retain only this exact read's
            // source items, while the failure remains visible and cannot page.
            return { ...page, items: prior.items, nextCursor: null };
        }) };
    }, revision, enabled);
    const pages = more?.first === read.value ? more.pages : read.value?.pages ?? EMPTY_PAGES;
    const paging = React.useRef(false);
    const nextPage = React.useCallback(async () => {
        if (paging.current) return;
        paging.current = true;
        const first = read.value;
        try {
            const following = await Promise.all(pages.filter(page => page.nextCursor !== null).map(async page => {
                const result = await read.execution.execute('registries.items.list', { ...input, sourceIds: [page.sourceId], cursor: page.nextCursor });
                if (!result.ok) throw new Error(result.error);
                return parse(result.result).pages;
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
    }, [input.kind, JSON.stringify(input.sourceIds), input.query, pages, read.execution.execute, read.execution.isCurrent, read.value]);
    return React.useMemo(() => ({ items: pages.flatMap(page => page.items), pages, loading: read.loading, stale: read.stale,
        sourceRevision: revision,
        error: read.error, nextPage, hasNextPage: pages.some(page => page.nextCursor !== null), refresh: read.refresh,
        sourceFailures: pages.filter(page => page.status.state !== 'ok').map(page => ({ sourceId: page.sourceId,
            message: describeRegistrySourceStatus(page.status), onRetry: read.refresh })),
    }), [pages, revision, read.loading, read.stale, read.error, nextPage, read.refresh]);
}
