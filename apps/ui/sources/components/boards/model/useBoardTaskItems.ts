import * as React from 'react';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { subscribeBoardTaskItems, type BoardTaskItems, type BoardTaskSource } from './boardTaskItems';

const EMPTY: BoardTaskItems = Object.freeze({ refs: [], linkedRefs: [], items: new Map(), complete: true, settled: true });
const NO_SOURCES: Readonly<Record<string, BoardTaskSource>> = Object.freeze({});
export const BoardTaskRefreshContext = React.createContext<(() => void) | undefined>(undefined);

/** Visit-local reads of the plugin's live owner, retired with the Account and exact registrations. */
export function useBoardTaskItems(serverId: string | null, refs: readonly BoardItemRefV1[],
    filtered: readonly BoardItemRefV1[] | null | undefined, enabled = true): BoardTaskItems {
    const refreshCurrent = React.useRef<(() => Promise<void>) | null>(null);
    const refreshItems = React.useCallback(() => { void refreshCurrent.current?.(); }, []);
    const projection = useAppShellPluginUiProjection(view => ({ accountLifetime: view.accountLifetime,
        interactionEnabled: view.interactionEnabled, sources: view.pluginUiProjection?.workItemsById ?? NO_SOURCES }));
    const platform = resolvePluginUiClientExecutablePlatform();
    const composition = getInstalledPluginUiClientExecutableComposition();
    const sources = projection.sources;
    const demanded = enabled && serverId !== null && (refs.some(ref => ref.kind === 'task')
        || filtered !== undefined && Object.keys(sources).length > 0);
    const subscribe = React.useCallback((listener: () => void) => demanded ? composition.subscribe(listener) : () => {}, [composition, demanded]);
    const revision = React.useSyncExternalStore(subscribe, composition.revision, composition.revision);
    const selectionKey = JSON.stringify([refs.filter(ref => ref.kind === 'task').map(buildWorkBoardItemKeyV1),
        (filtered ?? []).filter(ref => ref.kind === 'session').map(buildWorkBoardItemKeyV1)]);
    const accountLifetime = projection.accountLifetime;
    const unanswered = React.useMemo((): BoardTaskItems => {
        const picked = refs.filter(ref => ref.kind === 'task');
        const unavailable = !projection.interactionEnabled || !accountLifetime?.isCurrent();
        return { refs: picked, linkedRefs: [], items: unavailable ? new Map(picked.map(ref => [buildWorkBoardItemKeyV1(ref), null])) : EMPTY.items,
            complete: false, settled: unavailable };
    }, [selectionKey, projection.interactionEnabled, accountLifetime]);
    const [state, setState] = React.useState<Readonly<{ selectionKey: string; serverId: string | null;
        lifetime: typeof accountLifetime; sources: typeof sources; revision: number; value: BoardTaskItems }> | null>(null);
    React.useEffect(() => {
        if (!demanded || !serverId || !accountLifetime?.isCurrent() || !projection.interactionEnabled) return;
        const controller = new AbortController();
        const sessions = (filtered ?? []).flatMap(ref => ref.kind === 'session'
            && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, serverId)
            ? [{ serverId: ref.qualifiedId.serverId, sessionId: ref.qualifiedId.id }] : []);
        const retirement = accountLifetime.onRetire(() => controller.abort());
        const subscription = subscribeBoardTaskItems({ serverId, refs, sessions, sources: Object.values(sources),
            platform, signal: controller.signal, accountLifetime }, value => {
            if (!controller.signal.aborted && accountLifetime.isCurrent()) setState({ selectionKey, serverId,
                lifetime: accountLifetime, sources, revision, value });
        });
        refreshCurrent.current = subscription.refresh;
        return () => {
            if (refreshCurrent.current === subscription.refresh) refreshCurrent.current = null;
            controller.abort();
            retirement.dispose();
            subscription.stop();
        };
    }, [accountLifetime, demanded, projection.interactionEnabled, platform, revision, selectionKey, serverId, sources]);
    const value = !demanded ? EMPTY : state?.selectionKey === selectionKey && state.serverId === serverId && state.lifetime === accountLifetime
        && accountLifetime?.isCurrent() && state.sources === sources && state.revision === revision && projection.interactionEnabled
        ? state.value : unanswered;
    return React.useMemo(() => demanded ? { ...value, refresh: refreshItems } : value, [demanded, refreshItems, value]);
}
