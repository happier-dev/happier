import type { BrowserControlState, BrowserControlViewState } from '../control';

export type BrowserToolbarModel = Readonly<{
    canNavigate: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    canReload: boolean;
    canStop: boolean;
    isLoading: boolean;
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
        };
    }
    return {
        canNavigate: view.adapterCapabilities.navigation.canNavigate,
        canGoBack: view.adapterCapabilities.navigation.canGoBack && view.canGoBack,
        canGoForward: view.adapterCapabilities.navigation.canGoForward && view.canGoForward,
        canReload: view.adapterCapabilities.navigation.canReload,
        canStop: view.adapterCapabilities.navigation.canStop && view.loadingState === 'loading',
        isLoading: view.loadingState === 'loading',
    };
}
