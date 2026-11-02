import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';
import { usePaneRegion } from '../paneRegion';
import { normalizeFileDetailsTab } from '../details/fileDetailsTab';
import { usePanePresentation } from '../panePresentation';
import { createBuiltinPaneDestination } from '../model/selectedPaneDestination';
import * as React from 'react';
import { Platform } from 'react-native';
import { useAppPaneContext, useOptionalAppPaneContext } from '../AppPaneProvider';
import { AppPaneContext } from '../AppPaneContext';
import { usePaneOverlayFocusReturnRef } from './usePaneOverlayFocusReturnRef';
import type { DetailsTab } from '../model/appPaneReducer';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveDetailsTabOpenAs, type LastPreviewOpen } from './resolveDetailsTabOpenAs';
import { buildDetailsWorkspaceStateView } from '../details/workspace/detailsWorkspaceSelectors';
import { getOwnDetailsWorkspaceRecordEntry } from '../details/workspace/detailsWorkspaceTypes';
import type {
    DetailsWorkspaceAxis,
    DetailsWorkspaceOverlayState,
    DetailsWorkspacePlacement,
} from '../details/workspace/detailsWorkspaceTypes';
import type { PaneScopeState } from '../model/appPaneReducer';
import type { SelectedPaneDestinationV1 } from '../model/selectedPaneDestination';
import type {
    PluginUiDestinationReferenceV1,
    PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';

type AppPaneScopeDetailsStateView = {
    isOpen: boolean;
    tabState: Readonly<Record<string, unknown>>;
    tabs: ReturnType<typeof buildDetailsWorkspaceStateView>['tabs'];
    activeTabKey: string | null;
    groups?: ReturnType<typeof buildDetailsWorkspaceStateView>['groups'];
    root?: ReturnType<typeof buildDetailsWorkspaceStateView>['root'];
    focusedGroupId?: string | null;
    maximizedGroupId?: string | null;
    overlay?: DetailsWorkspaceOverlayState | null;
};

type AppPaneScopeStateView = {
    mainHidden: boolean;
    right: PaneScopeState['right'];
    details: AppPaneScopeDetailsStateView;
    bottom: PaneScopeState['bottom'];
};

/** Native capture handlers accepted by the React Native host at the scope boundary. */
export type NativeOverlayFocusReturnCaptureProps = Readonly<{
    onFocusCapture: (event: unknown) => void;
    onTouchStartCapture: (event: unknown) => void;
}>;

export type AppPaneScopeApi = {
    scopeId: string;
    scopeState: AppPaneScopeStateView | null;
    /** The current pane state is retained in memory but its device write failed. */
    persistenceFailed?: boolean;
    /** Native input capture props for the scope root that contains a pane opener. */
    overlayFocusReturnCaptureProps?: NativeOverlayFocusReturnCaptureProps;
    /** Ephemeral command-time focus for a Right overlay presentation. */
    rightOverlayFocusReturnRef?: FocusReturnMutableRef;
    /** Ephemeral command-time focus for the retained Details overlay. */
    detailsOverlayFocusReturnRef?: FocusReturnMutableRef;
    /** Ephemeral command-time focus for a Bottom overlay presentation. */
    bottomOverlayFocusReturnRef?: FocusReturnMutableRef;
    /** Command-time focus for the Editor-first folded main drawer. */
    mainOverlayFocusReturnRef?: FocusReturnMutableRef;
    /** URL hydration updates retained state without requesting navigation. */
    openRight: (options?: Readonly<{ tabId?: string; present?: boolean }>) => void;
    closeRight: () => void;
    setRightTab: (tabId: string) => void;
    selectRightDestination: (destination: SelectedPaneDestinationV1) => void;
    setRightTabState: (tabId: string, nextState: unknown) => void;
    openBottom: (options?: Readonly<{ tabId?: string }>) => void;
    closeBottom: () => void;
    setBottomTab: (tabId: string) => void;
    selectBottomDestination: (destination: SelectedPaneDestinationV1) => void;
    setBottomTabState: (tabId: string, nextState: unknown) => void;
    /** `origin` names the pane column a lent opener came from; it defaults to this caller's own column. */
    openDetailsTab: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview'; present?: boolean; origin?: DetailsOpenerRegion }>) => void;
    replaceDetailsTab: (tabKey: string, tab: DetailsTab, options?: Readonly<{
        intent?: 'default' | 'pinned' | 'preview';
        restoreSourceOnRehydrate?: boolean;
    }>) => void;
    setDetailsTabState: (tabKey: string, nextState: unknown, options?: Readonly<{ persist?: boolean }>) => void;
    patchDetailsTabState: (tabKey: string, patch: Readonly<Record<string, unknown>>, options?: Readonly<{ persist?: boolean }>) => void;
    pinDetailsTab: (tabKey: string, options?: Readonly<{ persist?: boolean }>) => void;
    unpinDetailsTab: (tabKey: string) => void;
    closeDetails: () => void;
    /** The host-owned full-bleed Details workspace overlay. */
    openDetailsOverlay?: (input: Readonly<{
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>) => void;
    closeDetailsOverlay?: () => void;
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

function getScopeState(scopeState: PaneScopeState | null): AppPaneScopeStateView | null {
    if (!scopeState) return null;
    return {
        mainHidden: scopeState.mainHidden,
        right: scopeState.right,
        details: buildDetailsWorkspaceStateView(scopeState.details),
        bottom: scopeState.bottom,
    };
}

/** The registered driver and scope API share one Details admission/presentation owner. */
export function useOptionalDetailsTabOpener(scopeId: string): AppPaneScopeApi['openDetailsTab'] | null {
    const subscription = React.useContext(AppPaneContext);
    const context = useOptionalAppPaneContext(value => ({ dispatch: value.dispatch }));
    const dispatch = context?.dispatch;
    const presentPane = usePanePresentation();
    const detailsPaneTabsBehavior = useLocalSetting('detailsPaneTabsBehavior');
    const paneRegion = usePaneRegion();
    const lastPreviewOpenRef = React.useRef<LastPreviewOpen | null>(null);
    const openDetailsTab = React.useCallback<AppPaneScopeApi['openDetailsTab']>((tab, options) => {
        if (!dispatch) return;
        tab = normalizeFileDetailsTab(tab, scopeId);
        const intent = options?.intent ?? 'default';
        const behavior = detailsPaneTabsBehavior === 'persistent' ? 'persistent' : 'preview';
        const details = subscription?.getSnapshot().state.scopes[scopeId]?.details;
        const existingTab = details ? getOwnDetailsWorkspaceRecordEntry(details.tabsByKey, tab.key) ?? null : null;
        const decision = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: behavior, intent,
            platform: Platform.OS === 'web' ? 'web' : 'native', nowMs: Date.now(), tabKey: tab.key,
            existingTab: existingTab ? { isPreview: existingTab.isPreview, isPinned: existingTab.isPinned } : null,
            lastPreviewOpen: lastPreviewOpenRef.current,
        });
        lastPreviewOpenRef.current = decision.nextLastPreviewOpen;
        dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: decision.openAs, origin: options?.origin ?? paneRegion });
        if (options?.present !== false) presentPane?.({ scopeId, pane: 'details', tab });
    }, [detailsPaneTabsBehavior, dispatch, paneRegion, presentPane, scopeId, subscription]);
    return dispatch ? openDetailsTab : null;
}

export function useAppPaneScope<T>(scopeId: string, selector: (scope: PaneScopeState | null) => T): Omit<AppPaneScopeApi, 'scopeState'> & { scopeState: T };
export function useAppPaneScope(scopeId: string): AppPaneScopeApi;
export function useAppPaneScope<T>(scopeId: string, selector?: (scope: PaneScopeState | null) => T) {
    const { dispatch, getReadState, overlayFocusReturnOwner, persistenceFailed } = useAppPaneContext(value => ({
        dispatch: value.dispatch,
        getReadState: value.getReadState,
        overlayFocusReturnOwner: value.overlayFocusReturnOwner,
        persistenceFailed: value.persistenceFailed,
    }));
    const selected = useAppPaneContext(value => {
        const scope = value.state.scopes[scopeId] ?? null;
        return selector ? selector(scope) : scope;
    });
    const scopeState = React.useMemo(() => selector ? selected : getScopeState(selected as PaneScopeState | null), [selected, selector]);
    const presentPane = usePanePresentation();
    const openDetailsTab = useOptionalDetailsTabOpener(scopeId)!;
    const rightOverlayFocusReturnRef = usePaneOverlayFocusReturnRef(scopeId, 'right');
    const detailsOverlayFocusReturnRef = usePaneOverlayFocusReturnRef(scopeId, 'details');
    const bottomOverlayFocusReturnRef = usePaneOverlayFocusReturnRef(scopeId, 'bottom');
    const mainOverlayFocusReturnRef = usePaneOverlayFocusReturnRef(scopeId, 'main');
    const recordNativeFocusTarget = React.useCallback((event: unknown) => {
        const target = (event as Readonly<{
            nativeEvent?: Readonly<{ target?: unknown }>;
        }>).nativeEvent?.target;
        overlayFocusReturnOwner.recordNativeFocusTarget(scopeId, target);
    }, [overlayFocusReturnOwner, scopeId]);
    const overlayFocusReturnCaptureProps = React.useMemo<NativeOverlayFocusReturnCaptureProps | undefined>(() => {
        if (Platform.OS === 'web' || typeof document !== 'undefined') return undefined;
        return {
            onFocusCapture: recordNativeFocusTarget,
            onTouchStartCapture: recordNativeFocusTarget,
        };
    }, [recordNativeFocusTarget]);

    const openRight = React.useCallback((options?: Readonly<{ tabId?: string; present?: boolean }>) => {
        const destination = options?.tabId ? createBuiltinPaneDestination(options.tabId)
            : getReadState().scopes[scopeId]?.right.selectedDestination ?? null;
        dispatch({ type: 'openRight', scopeId, tabId: options?.tabId });
        if (options?.present !== false) presentPane?.({ scopeId, pane: 'right', destination });
    }, [dispatch, getReadState, presentPane, scopeId]);

    const closeRight = React.useCallback(() => {
        dispatch({ type: 'closeRight', scopeId });
    }, [dispatch, scopeId]);

    const setRightTab = React.useCallback((tabId: string) => {
        const destination = createBuiltinPaneDestination(tabId);
        dispatch({ type: 'setRightTab', scopeId, tabId });
        presentPane?.({ scopeId, pane: 'right', destination });
    }, [dispatch, presentPane, scopeId]);

    const selectRightDestination = React.useCallback((destination: SelectedPaneDestinationV1) => {
        dispatch({ type: 'selectRightDestination', scopeId, destination });
        presentPane?.({ scopeId, pane: 'right', destination });
    }, [dispatch, presentPane, scopeId]);

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

    const selectBottomDestination = React.useCallback((destination: SelectedPaneDestinationV1) => {
        dispatch({ type: 'selectBottomDestination', scopeId, destination });
    }, [dispatch, scopeId]);

    const setBottomTabState = React.useCallback((tabId: string, nextState: unknown) => {
        dispatch({ type: 'setBottomTabState', scopeId, tabId, nextState });
    }, [dispatch, scopeId]);

    const setDetailsTabState = React.useCallback<AppPaneScopeApi['setDetailsTabState']>((tabKey, nextState, options) => {
        dispatch({ type: 'setDetailsTabState', scopeId, tabKey, nextState, ...options });
    }, [dispatch, scopeId]);
    const patchDetailsTabState = React.useCallback<AppPaneScopeApi['patchDetailsTabState']>((tabKey, patch, options) => {
        dispatch({ type: 'patchDetailsTabState', scopeId, tabKey, patch, ...options });
    }, [dispatch, scopeId]);

    const replaceDetailsTab = React.useCallback((tabKey: string, tab: DetailsTab, options?: Readonly<{
        intent?: 'default' | 'pinned' | 'preview';
        restoreSourceOnRehydrate?: boolean;
    }>) => {
        tab = normalizeFileDetailsTab(tab, scopeId);
        const intent = options?.intent ?? 'default';
        const openAs = intent === 'pinned' || intent === 'preview' ? intent : undefined;
        dispatch({
            type: 'replaceDetailsTab',
            scopeId,
            tabKey,
            tab,
            openAs,
            ...(options?.restoreSourceOnRehydrate ? { restoreSourceOnRehydrate: true } : {}),
        });
    }, [dispatch, scopeId]);

    const pinDetailsTab = React.useCallback<AppPaneScopeApi['pinDetailsTab']>((tabKey, options) => {
        dispatch({ type: 'pinDetailsTab', scopeId, tabKey, ...options });
    }, [dispatch, scopeId]);

    const unpinDetailsTab = React.useCallback((tabKey: string) => {
        dispatch({ type: 'unpinDetailsTab', scopeId, tabKey });
    }, [dispatch, scopeId]);

    const closeDetails = React.useCallback(() => {
        dispatch({ type: 'closeDetails', scopeId });
    }, [dispatch, scopeId]);

    const openDetailsOverlay = React.useCallback((input: Readonly<{
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>) => {
        dispatch({
            type: 'openDetailsOverlay',
            scopeId,
            destination: input.destination,
            ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
        });
    }, [dispatch, scopeId]);

    const closeDetailsOverlay = React.useCallback(() => {
        dispatch({ type: 'closeDetailsOverlay', scopeId });
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

    // The api object lands in `useCallback`/`useMemo` dependency lists across its callsites
    // (`useOpenAttachedSessionTerminal`, `SessionHeaderTranscriptNavigationButton`, ...), whose
    // results are then compared by identity further up — notably by `SessionHeaderActionMenu`'s
    // `onSelectExtraItem` guard. Returning a fresh literal per render invalidated all of them on
    // every host render, so the comparator never held.
    return React.useMemo(() => ({
        scopeId,
        scopeState,
        persistenceFailed,
        overlayFocusReturnCaptureProps,
        rightOverlayFocusReturnRef,
        detailsOverlayFocusReturnRef,
        bottomOverlayFocusReturnRef,
        mainOverlayFocusReturnRef,
        openRight,
        closeRight,
        setRightTab,
        selectRightDestination,
        setRightTabState,
        openBottom,
        closeBottom,
        setBottomTab,
        selectBottomDestination,
        setBottomTabState,
        openDetailsTab,
        replaceDetailsTab,
        setDetailsTabState,
        patchDetailsTabState,
        pinDetailsTab,
        unpinDetailsTab,
        closeDetails,
        openDetailsOverlay,
        closeDetailsOverlay,
        closeDetailsTab,
        setActiveDetailsTab,
        splitDetailsGroup,
        setDetailsSplitRatio,
        moveDetailsTabToGroup,
        focusDetailsGroup,
        setMaximizedDetailsGroup,
        closeDetailsGroup,
    }), [
        scopeId,
        scopeState,
        persistenceFailed,
        overlayFocusReturnCaptureProps,
        rightOverlayFocusReturnRef,
        detailsOverlayFocusReturnRef,
        bottomOverlayFocusReturnRef,
        mainOverlayFocusReturnRef,
        openRight,
        closeRight,
        setRightTab,
        selectRightDestination,
        setRightTabState,
        openBottom,
        closeBottom,
        setBottomTab,
        selectBottomDestination,
        setBottomTabState,
        openDetailsTab,
        replaceDetailsTab,
        setDetailsTabState,
        patchDetailsTabState,
        pinDetailsTab,
        unpinDetailsTab,
        closeDetails,
        openDetailsOverlay,
        closeDetailsOverlay,
        closeDetailsTab,
        setActiveDetailsTab,
        splitDetailsGroup,
        setDetailsSplitRatio,
        moveDetailsTabToGroup,
        focusDetailsGroup,
        setMaximizedDetailsGroup,
        closeDetailsGroup,
    ]);
}
