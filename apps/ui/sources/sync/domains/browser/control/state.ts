import type {
    BrowserAdapterCapabilitiesV1,
    BrowserNavigationLoadingStateV1,
    BrowserPlatformV1,
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
    BrowserSessionStateV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';

export type BrowserAdapterRefreshStatus = 'idle' | 'refreshing' | 'error';

export type BrowserControlSessionState = Readonly<{
    browserSessionId: string;
    profileId: string;
    state: BrowserSessionStateV1;
    createdAt: number;
    closedAt?: number;
}>;

export type BrowserControlViewState = Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
    platform: BrowserPlatformV1;
    adapterKind: BrowserSemanticAdapterKindV1;
    engineKind: Exclude<BrowserRenderEngineKindV1, 'unavailable'>;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    currentUrl: string | null;
    currentUrlExpiresAt: number | null;
    pendingUrl: string | null;
    title: string | null;
    faviconUrl: string | null;
    loadingState: BrowserNavigationLoadingStateV1;
    loadingProgress: number | null;
    navigationGeneration: number;
    canGoBack: boolean;
    canGoForward: boolean;
    securityOrigin: string | null;
    lastError: string | null;
    openerViewId: string | null;
    adapterRefreshStatus: BrowserAdapterRefreshStatus;
    adapterRefreshError: string | null;
}>;

/**
 * Per-view CONTENT lifecycle only. Tab order/active/open/close/pin/split are owned by the
 * details-workspace engine (one tab system, host-side), so this control state no longer carries
 * any per-session ordering or focus map. "Which view is active" is derived from the
 * workspace-selected `browser-view` tab's `resource.viewId`; within a single content record the
 * sole view per session is the active one. `currentTarget` remains a derived convenience pointer
 * (the most recent view's target).
 */
export type BrowserControlState = Readonly<{
    sessionsById: Readonly<Record<string, BrowserControlSessionState>>;
    viewsById: Readonly<Record<string, BrowserControlViewState>>;
    currentTarget: BrowserViewTargetV1 | null;
}>;
