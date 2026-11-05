import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppState } from 'react-native';
import type { SavedSecretDisclosureHistoryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { savedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretDisclosureHistoryInContext } from '@/sync/ops/settings/savedSecretDisclosure';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type Page = ReturnType<typeof SavedSecretDisclosureHistoryV1Schema.parse>;
type State = Readonly<{ status: 'idle' | 'loading' | 'refused' }>
    | Readonly<{ status: 'ready'; entries: Page['items']; nextCursor: string | null }>;
const idle = { status: 'idle' } as const;
const noOperation = () => {};

/** Visible, transient metadata only; persisted history remains owned by resourceActivity. */
export function useSharedSavedSecretActivity(input: Readonly<{
    scope: ServerAccountScope; resourceId: string; enabled: boolean;
}>) {
    const presented = useLayoutPresentationActive();
    const [snapshot, setSnapshot] = React.useState<Readonly<{ serverId: string; accountId: string; resourceId: string; state: State }> | null>(null);
    const snapshotRef = React.useRef(snapshot);
    snapshotRef.current = snapshot;
    const current = React.useRef(input);
    current.current = input;
    const commands = React.useRef({ refresh: noOperation, loadMore: noOperation });
    React.useEffect(() => {
        if (!input.enabled || !presented) return;
        const { serverId, accountId } = input.scope;
        const resourceId = input.resourceId;
        const controller = new AbortController();
        const exact = () => !controller.signal.aborted && current.current.enabled
            && current.current.scope.serverId === serverId && current.current.scope.accountId === accountId
            && current.current.resourceId === resourceId;
        const foreground = () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
            && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
        const retained = snapshotRef.current;
        let page: Extract<State, { status: 'ready' }> | null = retained?.serverId === serverId
            && retained.accountId === accountId && retained.resourceId === resourceId && retained.state.status === 'ready'
            ? retained.state : null;
        let reading = false;
        let refreshPending = false;
        const publish = (state: State) => {
            if (exact()) setSnapshot(previous => previous?.state === state ? previous : { serverId, accountId, resourceId, state });
        };
        if (!page) publish({ status: 'loading' });
        const accountPromise = captureLazyActionAccountContext(serverId, controller.signal);
        let releaseRetirement: (() => void) | undefined;
        void accountPromise.then(account => {
            if (!exact()) { account.dispose(); return; }
            const retirement = account.accountLifetime.onRetire(() => { publish(idle); controller.abort(); });
            releaseRetirement = () => { retirement.dispose(); account.dispose(); };
        }).catch(() => {}); // The read below presents this same capture failure.
        const read = async (cursor?: string): Promise<void> => {
            if (!exact()) return;
            if (reading || !foreground()) { if (!cursor) refreshPending = true; return; }
            reading = true;
            refreshPending = false;
            try {
                const account = await accountPromise;
                account.assertCurrent();
                if (account.accountId !== accountId) { publish({ status: 'refused' }); return; }
                // A resource-only hint can update any consumed entry. Re-read
                // through the oldest consumed row, preserving the window and
                // its cursor rather than replacing it with just page one.
                const oldestConsumedId = cursor ? undefined : page?.entries.at(-1)?.id;
                const refreshed: Page['items'] = [];
                let nextCursor: string | null = cursor ?? null;
                do {
                    if (!foreground()) { refreshPending = true; return; }
                    const result = await readSavedSecretDisclosureHistoryInContext(account,
                        { resourceId, ...(nextCursor ? { cursor: nextCursor } : {}) }, controller.signal);
                    if (!exact()) return;
                    if (!result.ok) { publish({ status: 'refused' }); return; }
                    refreshed.push(...result.value.items);
                    nextCursor = result.value.nextCursor;
                    if (cursor || !oldestConsumedId || result.value.items.some(entry => entry.id === oldestConsumedId)) break;
                } while (nextCursor);
                const previous = new Map(page?.entries.map(entry => [entry.id, entry]));
                const incoming = refreshed.map(entry => {
                    const retained = previous.get(entry.id);
                    return retained && JSON.stringify(retained) === JSON.stringify(entry) ? retained : entry;
                });
                const ids = new Set(incoming.map(entry => entry.id));
                const entries = cursor ? [...(page?.entries.filter(entry => !ids.has(entry.id)) ?? []), ...incoming] : incoming;
                if (!page || page.nextCursor !== nextCursor || page.entries.length !== entries.length
                    || entries.some((entry, index) => page?.entries[index] !== entry)) {
                    page = { status: 'ready', entries, nextCursor };
                }
                publish(page);
            } catch { if (exact()) publish({ status: 'refused' }); }
            finally {
                reading = false;
                if (refreshPending && exact() && foreground()) void read();
            }
        };
        const refresh = () => { void read(); };
        commands.current = { refresh, loadMore: () => { if (page?.nextCursor) void read(page.nextCursor); } };
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (event.serverId === serverId && (event.entityIds === undefined
                || event.entityIds.includes(savedSecretDisclosureActivityEntityIdV1(resourceId)))) refresh();
        }, { serverIds: [serverId], reconnect: { readNotCurrent: () => snapshotRef.current?.state.status !== 'ready' } });
        const native = AppState.addEventListener('change', next => { if (next === 'active' && refreshPending) refresh(); });
        const visibility = () => { if (foreground() && refreshPending) refresh(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
        refresh();
        return () => {
            controller.abort();
            commands.current = { refresh: noOperation, loadMore: noOperation };
            unsubscribe(); native.remove();
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
            releaseRetirement?.();
        };
    }, [input.scope.serverId, input.scope.accountId, input.resourceId, input.enabled, presented]);
    const state = input.enabled && snapshot?.serverId === input.scope.serverId
        && snapshot.accountId === input.scope.accountId && snapshot.resourceId === input.resourceId ? snapshot.state : idle;
    return { state, refresh: React.useCallback(() => commands.current.refresh(), []),
        loadMore: React.useCallback(() => commands.current.loadMore(), []) };
}
