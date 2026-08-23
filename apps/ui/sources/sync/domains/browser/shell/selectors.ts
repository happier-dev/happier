import type { BrowserControlState, BrowserControlViewState } from '../control';

export type BrowserToolbarModel = Readonly<{
    canNavigate: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    canReload: boolean;
    canStop: boolean;
    isLoading: boolean;
    /**
     * Whether the engine can EVER report back/forward history, as opposed to whether history is
     * available right now. A permanently-disabled control is a lie about the product: a sandboxed
     * cross-origin iframe cannot read its guest's history, and the Wry desktop child view has
     * neither a history producer nor a forward dispatcher. Those engines hide the pair; an engine
     * that reports history (the RN `WebView`, a daemon-authoritative streamed surface) shows it and
     * enables it from `canGoBack`/`canGoForward`.
     *
     * The decision lives here, in the capability layer the chrome consumes, so the toolbar never
     * re-derives per-engine truth.
     */
    showBackForward: boolean;
    /** Whether reload/stop exist at all on this engine (they share one toggling control). */
    showReloadStop: boolean;
}>;

/**
 * Look up a single view's CONTENT by its `viewId`. The active `viewId` is supplied by the
 * workspace-selected `browser-view` tab's `resource.viewId` — ordering/active live in the
 * workspace, not here.
 */
export function selectBrowserViewContent(
    state: BrowserControlState,
    viewId: string | null | undefined,
): BrowserControlViewState | null {
    return viewId ? state.viewsById[viewId] ?? null : null;
}

/**
 * Resolve the active view for a content record. A `browser-view` host holds exactly one view per
 * `browserSessionId`; when a `viewId` is known (from the tab resource) it is preferred, otherwise
 * the sole view for the session is returned.
 */
export function selectActiveBrowserView(
    state: BrowserControlState,
    browserSessionId: string,
    viewId?: string | null,
): BrowserControlViewState | null {
    if (viewId && state.viewsById[viewId]) {
        return state.viewsById[viewId];
    }
    for (const view of Object.values(state.viewsById)) {
        if (view.browserSessionId === browserSessionId) {
            return view;
        }
    }
    return null;
}

export function selectBrowserToolbarModel(view: BrowserControlViewState | null): BrowserToolbarModel {
    if (!view) {
        return {
            canNavigate: false,
            canGoBack: false,
            canGoForward: false,
            canReload: false,
            canStop: false,
            isLoading: false,
            showBackForward: false,
            showReloadStop: false,
        };
    }
    const navigation = view.adapterCapabilities.navigation;
    return {
        canNavigate: navigation.canNavigate,
        canGoBack: navigation.canGoBack && view.canGoBack,
        canGoForward: navigation.canGoForward && view.canGoForward,
        canReload: navigation.canReload,
        canStop: navigation.canStop && view.loadingState === 'loading',
        isLoading: view.loadingState === 'loading',
        showBackForward: navigation.canGoBack || navigation.canGoForward,
        showReloadStop: navigation.canReload || navigation.canStop,
    };
}
