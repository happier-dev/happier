import * as React from 'react';
import { Platform } from 'react-native';
import { useAppPaneContext } from '../AppPaneProvider';
import type { DetailsTab } from '../model/appPaneReducer';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveDetailsTabOpenAs, type LastPreviewOpen } from './resolveDetailsTabOpenAs';
import { buildDetailsWorkspaceStateView } from '../details/workspace/detailsWorkspaceSelectors';
import type {
    DetailsWorkspaceAxis,
    DetailsWorkspacePlacement,
} from '../details/workspace/detailsWorkspaceTypes';
import type { PaneScopeState } from '../model/appPaneReducer';

type AppPaneScopeDetailsStateView = {
    isOpen: boolean;
    tabState: Readonly<Record<string, unknown>>;
    tabs: ReturnType<typeof buildDetailsWorkspaceStateView>['tabs'];
    activeTabKey: string | null;
    groups?: ReturnType<typeof buildDetailsWorkspaceStateView>['groups'];
    root?: ReturnType<typeof buildDetailsWorkspaceStateView>['root'];
    focusedGroupId?: string | null;
    maximizedGroupId?: string | null;
};

type AppPaneScopeStateView = {
    right: PaneScopeState['right'];
    details: AppPaneScopeDetailsStateView;
    bottom: PaneScopeState['bottom'];
};

export type AppPaneScopeApi = {
    scopeId: string;
    scopeState: AppPaneScopeStateView | null;
    openRight: (options?: Readonly<{ tabId?: string }>) => void;
    closeRight: () => void;
    setRightTab: (tabId: string) => void;
    setRightTabState: (tabId: string, nextState: unknown) => void;
    openBottom: (options?: Readonly<{ tabId?: string }>) => void;
    closeBottom: () => void;
    setBottomTab: (tabId: string) => void;
    setBottomTabState: (tabId: string, nextState: unknown) => void;
    openDetailsTab: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    replaceDetailsTab: (tabKey: string, tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    setDetailsTabState: (tabKey: string, nextState: unknown) => void;
    pinDetailsTab: (tabKey: string) => void;
    unpinDetailsTab: (tabKey: string) => void;
    closeDetails: () => void;
    closeDetailsTab: (tabKey: string) => void;
    setActiveDetailsTab: (tabKey: string) => void;
    splitDetailsGroup?: (options: Readonly<{
        axis: DetailsWorkspaceAxis;
        groupId?: string;
        placement?: DetailsWorkspacePlacement;
    }>) => void;
    setDetailsSplitRatio?: (splitId: string, ratio: number) => void;
    moveDetailsTabToGroup?: (tabKey: string, targetGroupId: string) => void;
    focusDetailsGroup?: (groupId: string) => void;
    setMaximizedDetailsGroup?: (groupId: string | null) => void;
    closeDetailsGroup?: (groupId: string) => void;
};

function getScopeState(state: ReturnType<typeof useAppPaneContext>['state'], scopeId: string): AppPaneScopeStateView | null {
    const scopeState = state.scopes[scopeId] ?? null;
    if (!scopeState) return null;
    return {
        right: scopeState.right,
        details: buildDetailsWorkspaceStateView(scopeState.details),
        bottom: scopeState.bottom,
    };
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

    const replaceDetailsTab = React.useCallback((tabKey: string, tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => {
        const intent = options?.intent ?? 'default';
        const openAs = intent === 'pinned' || intent === 'preview' ? intent : undefined;
        dispatch({ type: 'replaceDetailsTab', scopeId, tabKey, tab, openAs });
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

    const splitDetailsGroup = React.useCallback((options: Readonly<{
        axis: DetailsWorkspaceAxis;
        groupId?: string;
        placement?: DetailsWorkspacePlacement;
    }>) => {
        dispatch({
            type: 'splitDetailsGroup',
            scopeId,
            axis: options.axis,
            groupId: options.groupId,
            placement: options.placement,
        });
    }, [dispatch, scopeId]);

    const setDetailsSplitRatio = React.useCallback((splitId: string, ratio: number) => {
        dispatch({ type: 'setDetailsSplitRatio', scopeId, splitId, ratio });
    }, [dispatch, scopeId]);

    const moveDetailsTabToGroup = React.useCallback((tabKey: string, targetGroupId: string) => {
        dispatch({ type: 'moveDetailsTabToGroup', scopeId, tabKey, targetGroupId });
    }, [dispatch, scopeId]);

    const focusDetailsGroup = React.useCallback((groupId: string) => {
        dispatch({ type: 'focusDetailsGroup', scopeId, groupId });
    }, [dispatch, scopeId]);

    const setMaximizedDetailsGroup = React.useCallback((groupId: string | null) => {
        dispatch({ type: 'setMaximizedDetailsGroup', scopeId, groupId });
    }, [dispatch, scopeId]);

    const closeDetailsGroup = React.useCallback((groupId: string) => {
        dispatch({ type: 'closeDetailsGroup', scopeId, groupId });
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
        replaceDetailsTab,
        setDetailsTabState,
        pinDetailsTab,
        unpinDetailsTab,
        closeDetails,
        closeDetailsTab,
        setActiveDetailsTab,
        splitDetailsGroup,
        setDetailsSplitRatio,
        moveDetailsTabToGroup,
        focusDetailsGroup,
        setMaximizedDetailsGroup,
        closeDetailsGroup,
    };
}
