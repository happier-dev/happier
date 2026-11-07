import * as React from 'react';
import { retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { readUiSharedBotTemplateSummaries } from '@/sync/ops/actions/botTemplateActionDeps';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { subscribeBotTemplateArtifactChanges } from '@/components/sessions/bots/templates/botTemplateArtifactChanges';

type Page = Awaited<ReturnType<typeof readUiSharedBotTemplateSummaries>>;
const EMPTY: Page = { items: [], coverage: 'complete' };

/** The Artifact owner selects received releases before paging; this surface never opens bodies. */
export function useReceivedBotTemplates(query: string, presented: boolean) {
    const execution = useMountedActionExecution(useAccountSettingsScope());
    const key = JSON.stringify([execution.binding?.scope, execution.binding?.revision, query]);
    const current = React.useRef(key);
    current.current = key;
    const loadedPages = React.useRef({ key, count: 1 });
    const [state, setState] = React.useState<{ key: string; page: Page; loading: boolean; error: string | null }>({ key, page: EMPTY, loading: false, error: null });
    const load = React.useCallback(async (cursor?: string) => {
        if (!presented || !execution.ready || !execution.binding) return;
        setState(previous => ({ key, page: previous.key === key ? previous.page : EMPTY, loading: true, error: null }));
        try {
            const depth = loadedPages.current.key === key ? loadedPages.current.count : 1;
            const items: Page['items'][number][] = [];
            let nextCursor = cursor;
            let coverage: Page['coverage'] = 'complete';
            let count = 0;
            // Refresh the structural pages already requested, following fresh cursors after changes.
            do {
                const page = await readUiSharedBotTemplateSummaries({ serverId: execution.binding.scope.serverId,
                    expectedAccountId: execution.binding.scope.accountId, query, ...(nextCursor ? { cursor: nextCursor } : {}) });
                if (current.current !== key || !execution.isCurrent()) return;
                items.push(...page.items);
                if (page.coverage === 'partial') coverage = 'partial';
                nextCursor = page.nextCursor;
                count++;
            } while (!cursor && nextCursor && count < depth);
            loadedPages.current = { key, count: cursor ? depth + 1 : count };
            setState(previous => {
                const before = previous.key === key ? previous.page : EMPTY;
                const next: Page = { items: retainKeyedRows(before.items, cursor ? [...before.items, ...items] : items,
                    item => item.source.artifactId), coverage: cursor && before.coverage === 'partial' ? 'partial' : coverage,
                    ...(nextCursor ? { nextCursor } : {}) };
                return { key, page: retainShallow(before, next), loading: false, error: null };
            });
        } catch (error) {
            if (current.current === key && execution.isCurrent()) setState(previous => ({ key,
                page: previous.key === key ? previous.page : EMPTY, loading: false, error: error instanceof Error ? error.message : 'artifact_content_unavailable' }));
        }
    }, [presented, execution.ready, execution.binding, execution.isCurrent, query, key]);
    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => presented && execution.ready && execution.binding
        ? subscribeBotTemplateArtifactChanges(execution.binding, () => { void load(); }) : undefined,
    [presented, execution.ready, execution.binding, load]);
    const page = state.key === key && execution.ready ? state.page : EMPTY;
    const refresh = React.useCallback(() => load(), [load]);
    const nextPage = React.useCallback(() => load(page.nextCursor), [load, page.nextCursor]);
    return { items: page.items, loading: presented && (!execution.ready || state.key !== key || state.loading),
        error: state.key === key ? state.error ?? (page.coverage === 'partial' ? 'artifact_content_unavailable' : null) : null,
        refresh, nextPage, hasNextPage: Boolean(page.nextCursor),
        serverId: execution.binding?.scope.serverId ?? null };
}
