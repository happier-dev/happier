import type {
    BrowserEventV1,
    BrowserRenderEngineKindV1,
} from '@happier-dev/protocol';

/**
 * Render engines that paint the page IN-PROCESS (a sandboxed iframe, an RN `WebView`, or the
 * Wry/Electron native child webview) and therefore own their own page-load lifecycle. A URL-bearing
 * open on one of these must seed `loading` (so the spinner shows) and rely on the engine reporting
 * load-end through {@link browserViewLifecycleEvent} → `applyBrowserControlEvent` to reach
 * `ready`/`failed` (B-2).
 *
 * The complement (`streamedSurface`) is DAEMON-AUTHORITATIVE: the daemon emits real navigation
 * events, so a URL-bearing open is already-rendered and never needs an in-app lifecycle bridge.
 * `unavailable` is the no-engine sentinel and is intentionally not a client-rendered engine.
 */
const CLIENT_RENDERED_BROWSER_ENGINE_KINDS: ReadonlySet<BrowserRenderEngineKindV1> = new Set<BrowserRenderEngineKindV1>([
    'webIframe',
    'nativeWebView',
    'desktopWebView',
    'electronWebContentsView',
]);

export function isClientRenderedBrowserEngine(engineKind: BrowserRenderEngineKindV1): boolean {
    return CLIENT_RENDERED_BROWSER_ENGINE_KINDS.has(engineKind);
}

/**
 * Canonical error code an in-app web engine (iframe / RN `WebView`) reports when a page-load
 * `onError` fires without a more specific native code. One owner so the iframe and native adapters
 * never drift on the string the reducer records as `lastError`.
 */
export const WEBVIEW_LOAD_FAILED_ERROR_CODE = 'webview_load_failed';

/**
 * The view a lifecycle signal targets. Page-load lifecycle is keyed by view identity only; the
 * reducer cases (`navigationStarted/Finished/Failed/loadingProgressChanged`) update the view by id.
 */
export type BrowserViewLifecycleTarget = Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

/**
 * A normalized page-load lifecycle signal an in-app render engine reports back to the control
 * reducer. Every client-rendered engine (iframe `onLoad`/`onError`, native `onLoadStart`/
 * `onLoadEnd`/`onError`, desktop `publishPageInfo`) maps its native callbacks onto this shape so the
 * SAME `applyBrowserControlEvent` path the daemon engines use moves `loadingState` to ready/failed.
 */
export type BrowserViewLifecycleSignal =
    | Readonly<{ kind: 'loadStarted'; url?: string | null }>
    | Readonly<{ kind: 'loadFinished'; url?: string | null }>
    | Readonly<{ kind: 'loadFailed'; errorCode: string; url?: string | null }>
    | Readonly<{ kind: 'loadingProgress'; progress: number }>
    | Readonly<{
        /**
         * The engine's own authoritative navigation snapshot, including the BACK/FORWARD history
         * flags. This is the only producer of `canGoBack`/`canGoForward` for a client-rendered
         * engine: `viewOpened` seeds both false and nothing else writes them, so without this
         * signal the toolbar's Back/Forward can never enable (G4).
         *
         * An engine emits it only where it has real history truth. React Native's `WebView` fires
         * `onNavigationStateChange` from its load-start and load-finish paths ONLY (never from the
         * error path), so this signal always trails the matching `loadStarted`/`loadFinished` and
         * can never resurrect a failed load as `ready`.
         */
        kind: 'navigationStateChanged';
        url?: string | null;
        title?: string | null;
        loading: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
      }>;

/** A view-bound sink an engine calls to feed its load lifecycle back to the control reducer. */
export type BrowserViewLifecycleEmitter = (signal: BrowserViewLifecycleSignal) => void;

/**
 * Maps an engine lifecycle {@link BrowserViewLifecycleSignal} onto the canonical
 * {@link BrowserEventV1} the control reducer consumes. Returns `null` when the signal carries no
 * actionable transition (e.g. a `loadStarted` with no URL — `navigationStarted` requires one).
 */
export function browserViewLifecycleEvent(
    target: BrowserViewLifecycleTarget,
    signal: BrowserViewLifecycleSignal,
): BrowserEventV1 | null {
    const base = {
        browserSessionId: target.browserSessionId,
        viewId: target.viewId,
        occurredAt: 0,
        eventId: `browser_lifecycle:${target.viewId}:${signal.kind}`,
    } as const;
    switch (signal.kind) {
        case 'loadStarted':
            if (!signal.url) {
                return null;
            }
            return { ...base, kind: 'navigationStarted', pendingUrl: signal.url };
        case 'loadFinished':
            return {
                ...base,
                kind: 'navigationFinished',
                ...(signal.url ? { currentUrl: signal.url } : {}),
            };
        case 'loadFailed':
            return {
                ...base,
                kind: 'navigationFailed',
                errorCode: signal.errorCode,
                ...(signal.url ? { failedUrl: signal.url } : {}),
            };
        case 'loadingProgress':
            return { ...base, kind: 'loadingProgressChanged', loadingProgress: signal.progress };
        case 'navigationStateChanged': {
            // While loading, the reported URL is the destination (pending); once the load settles it
            // is the committed document. Splitting it this way keeps the address bar showing the
            // pending target mid-navigation instead of the snapshot clearing it.
            const url = signal.url ?? null;
            return {
                ...base,
                kind: 'navigationStateChanged',
                loadingState: signal.loading ? 'loading' : 'ready',
                canGoBack: signal.canGoBack,
                canGoForward: signal.canGoForward,
                ...(url ? (signal.loading ? { pendingUrl: url } : { currentUrl: url }) : {}),
                ...(signal.title ? { title: signal.title } : {}),
            };
        }
    }
}
