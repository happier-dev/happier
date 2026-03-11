import * as React from 'react';
import { Platform } from 'react-native';
import { useAppPaneContext } from '../AppPaneProvider';
import type { DetailsTab } from '../model/appPaneReducer';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveDetailsTabOpenAs, type LastPreviewOpen } from './resolveDetailsTabOpenAs';

export type AppPaneScopeApi = Readonly<{
    scopeId: string;
    scopeState: ReturnType<typeof getScopeState>;
    openRight: (options?: Readonly<{ tabId?: string }>) => void;
    closeRight: () => void;
    setRightTab: (tabId: string) => void;
    setRightTabState: (tabId: string, nextState: unknown) => void;
    openBottom: (options?: Readonly<{ tabId?: string }>) => void;
    closeBottom: () => void;
    setBottomTab: (tabId: string) => void;
    setBottomTabState: (tabId: string, nextState: unknown) => void;
    openDetailsTab: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    setDetailsTabState: (tabKey: string, nextState: unknown) => void;
    pinDetailsTab: (tabKey: string) => void;
    unpinDetailsTab: (tabKey: string) => void;
    closeDetails: () => void;
    closeDetailsTab: (tabKey: string) => void;
    setActiveDetailsTab: (tabKey: string) => void;
}>;

function getScopeState(state: ReturnType<typeof useAppPaneContext>['state'], scopeId: string) {
    return state.scopes[scopeId] ?? null;
}

export function useAppPaneScope(scopeId: string): AppPaneScopeApi {
    const { state, dispatch } = useAppPaneContext();
    const scopeState = getScopeState(state, scopeId);
    const detailsPaneTabsBehavior = useLocalSetting('detailsPaneTabsBehavior');

    const lastPreviewOpenRef = React.useRef<LastPreviewOpen | null>(null);
    const detailsTabsRef = React.useRef<ReadonlyArray<{ key: string; isPreview: boolean; isPinned: boolean }> | null>(null);
    React.useEffect(() => {
        detailsTabsRef.current = scopeState?.details?.tabs ?? null;
    }, [scopeState?.details?.tabs]);

    const openRight = React.useCallback((options?: Readonly<{ tabId?: string }>) => {
        dispatch({ type: 'openRight', scopeId, tabId: options?.tabId });
    }, [dispatch, scopeId]);

    const closeRight = React.useCallback(() => {
        dispatch({ type: 'closeRight', scopeId });
    }, [dispatch, scopeId]);

    const setRightTab = React.useCallback((tabId: string) => {
        dispatch({ type: 'setRightTab', scopeId, tabId });
    }, [dispatch, scopeId]);

    const setRightTabState = React.useCallback((tabId: string, nextState: unknown) => {
        dispatch({ type: 'setRightTabState', scopeId, tabId, nextState });
    }, [dispatch, scopeId]);

    const openBottom = React.useCallback((options?: Readonly<{ tabId?: string }>) => {
        dispatch({ type: 'openBottom', scopeId, tabId: options?.tabId });
    }, [dispatch, scopeId]);

    const closeBottom = React.useCallback(() => {
        dispatch({ type: 'closeBottom', scopeId });
    }, [dispatch, scopeId]);

    const setBottomTab = React.useCallback((tabId: string) => {
        dispatch({ type: 'setBottomTab', scopeId, tabId });
    }, [dispatch, scopeId]);

    const setBottomTabState = React.useCallback((tabId: string, nextState: unknown) => {
        dispatch({ type: 'setBottomTabState', scopeId, tabId, nextState });
    }, [dispatch, scopeId]);

    const openDetailsTab = React.useCallback((tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => {
        const intent = options?.intent ?? 'default';
        const behavior = detailsPaneTabsBehavior === 'persistent' ? 'persistent' : 'preview';
        const nowMs = Date.now();
        const existingTab = (detailsTabsRef.current ?? []).find((t) => t.key === tab.key) ?? null;
        const decision = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: behavior,
            intent,
            platform: Platform.OS === 'web' ? 'web' : 'native',
            nowMs,
            tabKey: tab.key,
            existingTab: existingTab ? { isPreview: existingTab.isPreview, isPinned: existingTab.isPinned } : null,
            lastPreviewOpen: lastPreviewOpenRef.current,
        });
        lastPreviewOpenRef.current = decision.nextLastPreviewOpen;
        const openAs = decision.openAs;
        dispatch({ type: 'openDetailsTab', scopeId, tab, openAs });
    }, [detailsPaneTabsBehavior, dispatch, scopeId]);

    const setDetailsTabState = React.useCallback((tabKey: string, nextState: unknown) => {
        dispatch({ type: 'setDetailsTabState', scopeId, tabKey, nextState });
    }, [dispatch, scopeId]);

    const pinDetailsTab = React.useCallback((tabKey: string) => {
        dispatch({ type: 'pinDetailsTab', scopeId, tabKey });
    }, [dispatch, scopeId]);

    const unpinDetailsTab = React.useCallback((tabKey: string) => {
        dispatch({ type: 'unpinDetailsTab', scopeId, tabKey });
    }, [dispatch, scopeId]);

    const closeDetails = React.useCallback(() => {
        dispatch({ type: 'closeDetails', scopeId });
    }, [dispatch, scopeId]);

    const closeDetailsTab = React.useCallback((tabKey: string) => {
        dispatch({ type: 'closeDetailsTab', scopeId, tabKey });
    }, [dispatch, scopeId]);

    const setActiveDetailsTab = React.useCallback((tabKey: string) => {
        dispatch({ type: 'setActiveDetailsTab', scopeId, tabKey });
    }, [dispatch, scopeId]);

    return {
        scopeId,
        scopeState,
        openRight,
        closeRight,
        setRightTab,
        setRightTabState,
        openBottom,
        closeBottom,
        setBottomTab,
        setBottomTabState,
        openDetailsTab,
        setDetailsTabState,
        pinDetailsTab,
        unpinDetailsTab,
        closeDetails,
        closeDetailsTab,
        setActiveDetailsTab,
    };
}
