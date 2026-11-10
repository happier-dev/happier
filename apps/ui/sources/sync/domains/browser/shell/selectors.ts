import { resolveBrowserNavigationVerbAvailability } from '../adapters/capabilities';
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
    /**
     * AMD-8: set when the page itself keeps its history and loading from Happier (a third-party
     * page in the web iframe engine). Back, Forward and Stop then render unavailable with this
     * reason instead of hiding, so the person learns why and finds the browser-tab escape.
     */
    historyUnavailableReason: 'page_history_uncontrollable' | null;
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

export function selectBrowserToolbarModel(view: BrowserControlViewState | null, interactionEnabled = true): BrowserToolbarModel {
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
            historyUnavailableReason: null,
        };
    }
    const navigation = view.adapterCapabilities.navigation;
    // An ended relay preview has no page left to act on: its history and address belonged to it.
    // Reload stays, since it asks the proxy again.
    const ended = view.loadingState === 'failed' && view.lastError === 'preview_ended';
    const back = resolveBrowserNavigationVerbAvailability(view.adapterCapabilities, 'goBack');
    const historyUnavailableReason = !back.available && back.reasonCode === 'page_history_uncontrollable'
        ? back.reasonCode
        : null;
    return {
        canNavigate: interactionEnabled && navigation.canNavigate && !ended,
        canGoBack: interactionEnabled && navigation.canGoBack && view.canGoBack && !ended,
        canGoForward: interactionEnabled && navigation.canGoForward && view.canGoForward && !ended,
        canReload: interactionEnabled && navigation.canReload,
        canStop: interactionEnabled && navigation.canStop && view.loadingState === 'loading',
        isLoading: view.loadingState === 'loading',
        showBackForward: navigation.canGoBack || navigation.canGoForward || historyUnavailableReason !== null,
        showReloadStop: navigation.canReload || navigation.canStop,
        historyUnavailableReason,
    };
}
