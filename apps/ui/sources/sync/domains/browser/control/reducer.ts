import type {
    BrowserEventV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';

import { isClientRenderedBrowserEngine } from './lifecycle';
import type {
    BrowserControlState,
    BrowserControlViewState,
} from './state';

/**
 * The control state no longer holds an ordering/focus map (the workspace owns tab order/active).
 * `currentTarget` is a derived convenience pointer to the most recently materialized view's
 * target; with a single view per content record it is simply that view's target.
 */
function deriveCurrentTarget(
    viewsById: Readonly<Record<string, BrowserControlViewState>>,
    preferredViewId?: string,
): BrowserViewTargetV1 | null {
    if (preferredViewId && viewsById[preferredViewId]) {
        return viewsById[preferredViewId].target;
    }
    const views = Object.values(viewsById);
    return views.length > 0 ? views[views.length - 1].target : null;
}

export function createBrowserControlState(): BrowserControlState {
    return {
        sessionsById: {},
        viewsById: {},
        currentTarget: null,
    };
}

export function beginBrowserAdapterRefresh(state: BrowserControlState, viewId: string): BrowserControlState {
    const view = state.viewsById[viewId];
    if (!view) {
        return state;
    }
    return {
        ...state,
        viewsById: {
            ...state.viewsById,
            [viewId]: {
                ...view,
                adapterRefreshStatus: 'refreshing',
                adapterRefreshError: null,
            },
        },
    };
}

function createViewFromOpenedEvent(event: Extract<BrowserEventV1, { kind: 'viewOpened' }>): BrowserControlViewState {
    // A URL-bearing open on a CLIENT-RENDERED engine (iframe / RN WebView / Wry-desktop child view)
    // is NOT already-loaded: the engine still has to fetch+paint the page. Seed it as `loading` so
    // the spinner shows, and rely on the engine's load-end (onLoad/onLoadEnd/publishPageInfo) feeding
    // `navigationFinished` back through `applyBrowserControlEvent` to reach `ready` (B-2 cause-1 — the
    // old `'ready'`/progress-1 seed marked the page already-loaded so no spinner ever showed). A
    // daemon-authoritative engine (`streamedSurface`) emits real navigation events, so a URL-bearing
    // open there is genuinely already-rendered.
    const hasUrl = Boolean(event.currentUrl);
    const clientRendered = isClientRenderedBrowserEngine(event.engineKind);
    return {
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
        target: event.target,
        platform: event.platform,
        adapterKind: event.adapterKind,
        engineKind: event.engineKind,
        adapterCapabilities: event.adapterCapabilities,
        currentUrl: event.currentUrl ?? null,
        currentUrlExpiresAt: event.currentUrlExpiresAt ?? null,
        pendingUrl: null,
        title: event.target.display?.title ?? null,
        faviconUrl: null,
        loadingState: hasUrl ? (clientRendered ? 'loading' : 'ready') : 'idle',
        loadingProgress: hasUrl ? (clientRendered ? 0 : 1) : null,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: null,
        lastError: null,
        openerViewId: event.openerViewId ?? null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function resolveNextNavigationGeneration(
    view: BrowserControlViewState,
    nextUrl: string | null | undefined,
    options: Readonly<{ documentReplacement?: boolean }> = {},
): number {
    if (nextUrl == null) {
        return view.navigationGeneration;
    }
    if (options.documentReplacement || nextUrl !== view.currentUrl) {
        return view.navigationGeneration + 1;
    }
    return view.navigationGeneration;
}

function removeViewsForSession(
    viewsById: Readonly<Record<string, BrowserControlViewState>>,
    browserSessionId: string,
): Readonly<Record<string, BrowserControlViewState>> {
    const next = { ...viewsById };
    for (const [viewId, view] of Object.entries(next)) {
        if (view.browserSessionId === browserSessionId) {
            delete next[viewId];
        }
    }
    return next;
}

export function applyBrowserControlEvent(state: BrowserControlState, event: BrowserEventV1): BrowserControlState {
    switch (event.kind) {
        case 'sessionCreated':
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [event.browserSessionId]: {
                        browserSessionId: event.browserSessionId,
                        profileId: event.profileId,
                        state: 'active',
                        createdAt: event.occurredAt,
                    },
                },
                viewsById: state.viewsById,
                currentTarget: deriveCurrentTarget(state.viewsById),
            };
        case 'sessionClosed': {
            const viewsById = removeViewsForSession(state.viewsById, event.browserSessionId);
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [event.browserSessionId]: {
                        ...(state.sessionsById[event.browserSessionId] ?? {
                            browserSessionId: event.browserSessionId,
                            profileId: 'unknown',
                            createdAt: event.occurredAt,
                        }),
                        state: 'closed',
                        closedAt: event.occurredAt,
                    },
                },
                viewsById,
                currentTarget: deriveCurrentTarget(viewsById),
            };
        }
        case 'viewOpened': {
            const viewsById = {
                ...state.viewsById,
                [event.viewId]: createViewFromOpenedEvent(event),
            };
            return {
                sessionsById: state.sessionsById,
                viewsById,
                currentTarget: deriveCurrentTarget(viewsById, event.viewId),
            };
        }
        case 'viewClosed': {
            const viewsById = { ...state.viewsById };
            delete viewsById[event.viewId];
            return {
                sessionsById: state.sessionsById,
                viewsById,
                currentTarget: deriveCurrentTarget(viewsById),
            };
        }
        case 'viewFocused':
            // Focus is owned by the workspace engine; this remains only a derived-target hint so a
            // daemon-emitted focus event keeps `currentTarget` pointing at the focused view.
            return {
                ...state,
                currentTarget: deriveCurrentTarget(state.viewsById, event.viewId),
            };
        case 'targetChanged': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            const viewsById = {
                ...state.viewsById,
                [event.viewId]: {
                    ...view,
                    target: event.target,
                    currentUrl: event.currentUrl ?? view.currentUrl,
                    currentUrlExpiresAt: event.currentUrl && event.currentUrl !== view.currentUrl
                        ? null
                        : view.currentUrlExpiresAt,
                    navigationGeneration: resolveNextNavigationGeneration(view, event.currentUrl),
                    pendingUrl: null,
                    title: event.target.display?.title ?? view.title,
                    lastError: null,
                },
            };
            return {
                sessionsById: state.sessionsById,
                viewsById,
                currentTarget: deriveCurrentTarget(viewsById, event.viewId),
            };
        }
        case 'navigationStarted': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        pendingUrl: event.pendingUrl,
                        loadingState: 'loading',
                        loadingProgress: 0,
                        lastError: null,
                    },
                },
            };
        }
        case 'navigationCommitted': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        currentUrl: event.currentUrl,
                        currentUrlExpiresAt: event.currentUrl !== view.currentUrl ? null : view.currentUrlExpiresAt,
                        navigationGeneration: resolveNextNavigationGeneration(view, event.currentUrl, {
                            documentReplacement: true,
                        }),
                        pendingUrl: null,
                        securityOrigin: event.securityOrigin ?? view.securityOrigin,
                        loadingState: 'loading',
                    },
                },
            };
        }
        case 'navigationFinished': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        currentUrl: event.currentUrl ?? view.currentUrl,
                        currentUrlExpiresAt: event.currentUrl && event.currentUrl !== view.currentUrl
                            ? null
                            : view.currentUrlExpiresAt,
                        navigationGeneration: resolveNextNavigationGeneration(view, event.currentUrl),
                        pendingUrl: null,
                        loadingState: 'ready',
                        loadingProgress: 1,
                    },
                },
            };
        }
        case 'navigationFailed': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        pendingUrl: null,
                        loadingState: 'failed',
                        lastError: event.errorCode,
                    },
                },
            };
        }
        case 'navigationStateChanged': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        currentUrl: event.currentUrl ?? view.currentUrl,
                        pendingUrl: event.pendingUrl ?? null,
                        navigationGeneration: resolveNextNavigationGeneration(view, event.currentUrl),
                        title: event.title ?? view.title,
                        faviconUrl: event.faviconUrl ?? view.faviconUrl,
                        loadingState: event.loadingState,
                        loadingProgress: event.loadingProgress ?? view.loadingProgress,
                        canGoBack: event.canGoBack,
                        canGoForward: event.canGoForward,
                        securityOrigin: event.securityOrigin ?? view.securityOrigin,
                        lastError: event.lastError ?? null,
                    },
                },
            };
        }
        case 'titleChanged': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: { ...view, title: event.title },
                },
            };
        }
        case 'faviconChanged': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: { ...view, faviconUrl: event.faviconUrl ?? null },
                },
            };
        }
        case 'loadingProgressChanged': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: { ...view, loadingProgress: event.loadingProgress },
                },
            };
        }
        case 'viewCrashed':
        case 'adapterUnavailable': {
            const view = state.viewsById[event.viewId];
            if (!view) return state;
            return {
                ...state,
                viewsById: {
                    ...state.viewsById,
                    [event.viewId]: {
                        ...view,
                        loadingState: 'failed',
                        lastError: event.reasonCode,
                        adapterRefreshStatus: 'error',
                        adapterRefreshError: event.reasonCode,
                    },
                },
            };
        }
        case 'permissionRequested':
        case 'downloadRequested':
        case 'popupRequested':
        case 'externalOpenRequested':
            return state;
    }
}
