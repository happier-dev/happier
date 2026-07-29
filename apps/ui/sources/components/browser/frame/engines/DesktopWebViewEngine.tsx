import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    buildInjectedBrowserDiagnosticsElementPickerCommandScript,
    buildInjectedBrowserDiagnosticsEvalCommandScript,
    buildInjectedBrowserDiagnosticsGetPropertiesCommandScript,
    buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript,
    buildInjectedBrowserDiagnosticsScript,
    createNativeWebViewPageInfoDiagnosticEvent,
    createNativeWebViewUnavailableDiagnosticEvent,
    parseInjectedBrowserDiagnosticsMessage,
} from '@/components/browser/adapters/diagnostics';
import { BrowserFrameUnavailable } from '@/components/browser/frame/BrowserFrameUnavailable';
import { browserFrameStyles } from '@/components/browser/frame/styles';
import { Text } from '@/components/ui/text/Text';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import type { BrowserSurfaceLifecycleState } from '@/components/browser/surfaces/browserSurfaceLifecycle';
import {
    closeDesktopBrowserView,
    dispatchDesktopBrowserNavigation,
    drainDesktopBrowserDiagnostics,
    evalDesktopBrowserScript,
    navigateDesktopBrowserView,
    openDesktopBrowserDevtools,
    openDesktopBrowserView,
    readDesktopBrowserPageInfo,
    setDesktopBrowserPointerPassthrough,
    setDesktopBrowserViewBounds,
    type DesktopBrowserBoundsPayload,
    type DesktopBrowserCommandResult,
    type DesktopBrowserDrainDiagnosticsResult,
    type DesktopBrowserOpenViewRequest,
    type DesktopBrowserPageInfoResult,
    type DesktopBrowserPointerPassthroughPayload,
    type DesktopBrowserViewCommandRequest,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserControlViewState,
    type BrowserViewLifecycleEmitter,
    type BrowserViewLifecycleSignal,
} from '@/sync/domains/browser/control';
import type { DesktopBrowserPageInfo } from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import { t } from '@/text';

import {
    useDesktopWebViewSurfaceSync,
    type DesktopWebViewDragSignal,
    type DesktopWebViewSurfaceRect,
} from './useDesktopWebViewSurfaceSync';

/** Fixed, non-user-eval scripts injected through the trusted desktop seam for nav control. */
type DesktopWebViewInjectedNavigationKind = 'reload' | 'stop';

export type DesktopWebViewNavigationDispatchRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    kind: DesktopWebViewInjectedNavigationKind;
    script: string;
}>;

export type DesktopWebViewEngineBridge = Readonly<{
    openView: (request: DesktopBrowserOpenViewRequest) => Promise<DesktopBrowserCommandResult>;
    navigateView: (request: Required<DesktopBrowserViewCommandRequest>) => Promise<DesktopBrowserCommandResult>;
    setBounds: (request: DesktopBrowserBoundsPayload) => Promise<DesktopBrowserCommandResult>;
    setPointerPassthrough: (request: DesktopBrowserPointerPassthroughPayload) => Promise<DesktopBrowserCommandResult>;
    closeView: (request: Omit<DesktopBrowserViewCommandRequest, 'url'>) => Promise<DesktopBrowserCommandResult>;
    openDevtools: (request: Omit<DesktopBrowserViewCommandRequest, 'url'>) => Promise<DesktopBrowserCommandResult>;
    readPageInfo: (request: Omit<DesktopBrowserViewCommandRequest, 'url'>) => Promise<DesktopBrowserPageInfoResult>;
    /** Drains the native ipc buffer of injected-collector envelopes posted by the page since the last drain. */
    drainDiagnostics: (request: Omit<DesktopBrowserViewCommandRequest, 'url'>) => Promise<DesktopBrowserDrainDiagnosticsResult>;
    /** Evaluates a canonical injected diagnostics COMMAND script (eval/getProperties/release/picker) in the page; its result returns over the ipc/drain channel. */
    evalScript: (request: Readonly<{ browserSessionId: string; viewId: string; script: string }>) => Promise<DesktopBrowserCommandResult>;
    /**
     * Injects a fixed `location.reload()` / `window.stop()` script into the Wry child view
     * through the trusted native seam (never a user-eval surface). Shipped now per TRACKING
     * §12 Q3, but kept dormant in product until the `DesktopBrowserSupport.reload/stop`
     * capability bits flip (gated on the §5 Wry-honors-injection verification) — the toolbar
     * stays disabled, so this is never dispatched before the proof lands.
     */
    dispatchNavigation: (request: DesktopWebViewNavigationDispatchRequest) => Promise<DesktopBrowserCommandResult>;
}>;

const defaultBridge: DesktopWebViewEngineBridge = {
    openView: openDesktopBrowserView,
    navigateView: navigateDesktopBrowserView,
    setBounds: setDesktopBrowserViewBounds,
    setPointerPassthrough: setDesktopBrowserPointerPassthrough,
    closeView: closeDesktopBrowserView,
    openDevtools: openDesktopBrowserDevtools,
    readPageInfo: readDesktopBrowserPageInfo,
    drainDiagnostics: drainDesktopBrowserDiagnostics,
    evalScript: evalDesktopBrowserScript,
    dispatchNavigation: dispatchDesktopBrowserNavigation,
};

function buildInjectedNavigationScript(kind: DesktopWebViewInjectedNavigationKind): string {
    // Canonical fixed injection scripts mirroring the web iframe nav-control template.
    return kind === 'reload' ? 'location.reload()' : 'window.stop()';
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    crashedContainer: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        backgroundColor: theme.colors.surface.base,
    },
    crashedReloadButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
}));

function resolveViewUrl(view: BrowserControlViewState): string | null {
    if (view.target.kind !== 'externalUrl') {
        return null;
    }
    return view.pendingUrl ?? view.currentUrl ?? view.target.url;
}

function firstDisabledReason(result: DesktopBrowserCommandResult | DesktopBrowserPageInfoResult): string | null {
    return result.availability.disabledReasons[0] ?? null;
}

function isPageInfoLoading(loadingState: string): boolean {
    return loadingState === 'loading';
}

function isPageInfoCrashed(loadingState: string): boolean {
    return loadingState === 'crashed';
}

/**
 * Maps the native Wry page-info `loadingState` onto a control-reducer lifecycle signal (B-2
 * cause-2). The native truth (loading/finished/failed/crashed + current URL) was previously routed
 * to diagnostics ONLY, leaving an in-place-opened view stuck on a permanent spinner; this is what
 * transitions it to `ready`/`failed`. `idle` carries no actionable transition.
 */
function desktopPageInfoLifecycleSignal(pageInfo: DesktopBrowserPageInfo): BrowserViewLifecycleSignal | null {
    const url = pageInfo.currentUrl ?? pageInfo.requestedUrl;
    switch (pageInfo.loadingState) {
        case 'loading':
            return { kind: 'loadStarted', url };
        case 'finished':
            return { kind: 'loadFinished', url };
        case 'failed':
            return { kind: 'loadFailed', errorCode: pageInfo.lastError?.reason ?? WEBVIEW_LOAD_FAILED_ERROR_CODE, url };
        case 'crashed':
            return { kind: 'loadFailed', errorCode: 'desktop_webview_render_crashed', url };
        case 'idle':
            return null;
    }
}

export function DesktopWebViewEngine(props: Readonly<{
    view: BrowserControlViewState;
    profileId: string;
    testID: string;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig | null;
    bridge?: DesktopWebViewEngineBridge;
    pageInfoPollIntervalMs?: number | null;
    /**
     * Browser-surface lifecycle state the host computes (visible|hidden|parked|suspended|orphaned|
     * closed). Drives keep-mounted continuity: hidden/parked hide the native view (no reload on
     * return), suspended/closed/orphaned tear it down. Plumbed by the tab/split-canvas owner
     * (FP-BRW-TABS-1); when absent the view stays shown and is closed only on a genuine unmount.
     */
    lifecycleState?: BrowserSurfaceLifecycleState;
    /** Host-overlay sample-point hit-test: true when an @/modal or Popover overlaps the preview. */
    occlusionProbe?: () => boolean;
    /** Pane/sidebar resize-drag signal; pointer passthrough engages while it is active. */
    dragSignal?: DesktopWebViewDragSignal;
    /**
     * Latest reload/stop navigation command from the toolbar (same seam as the web/native
     * engines). Each new `commandId` injects the fixed `location.reload()` / `window.stop()`
     * script through the trusted native dispatch. Dormant in product until the reload/stop
     * capability bits flip (the toolbar enables the buttons only then).
     */
    navigationCommand?: BrowserFrameNavigationCommand;
    /**
     * B-2 cause-2: the page-load lifecycle sink. `publishPageInfo` (and the open/navigate failure
     * paths) feed it so the control reducer transitions `loading → ready/failed` instead of relying
     * on the diagnostics-only page-info events. Held in a ref so it never churns `publishPageInfo`.
     */
    onLifecycle?: BrowserViewLifecycleEmitter;
    nowMs?: () => number;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const bridge = props.bridge ?? defaultBridge;
    const onLifecycleRef = React.useRef<BrowserViewLifecycleEmitter | undefined>(props.onLifecycle);
    onLifecycleRef.current = props.onLifecycle;
    const desiredUrl = resolveViewUrl(props.view);
    const commandTarget = React.useMemo(() => ({
        browserSessionId: props.view.browserSessionId,
        viewId: props.view.viewId,
    }), [props.view.browserSessionId, props.view.viewId]);
    const viewKey = `${commandTarget.browserSessionId}:${commandTarget.viewId}:${props.profileId}`;
    const containerRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const desiredUrlRef = React.useRef<string | null>(desiredUrl);
    const lastRequestedUrlRef = React.useRef<string | null>(null);
    const pageInfoSequenceRef = React.useRef(0);
    const [unavailableReason, setUnavailableReason] = React.useState<string | null>(desiredUrl ? null : 'external_url_unavailable');
    // Last good URL captured when the render process crashed (macOS WebKit content-process
    // termination, the only platform with a native crash signal). Non-null renders the recoverable
    // crash surface; cleared on reload. Win/Linux never set this (no upstream crash callback).
    // Recovery is manual (user-initiated Reload) rather than a silent auto-reload: it can never
    // crash-loop a pathological page, and the user stays in control of re-running the dead view.
    const [crashedUrl, setCrashedUrl] = React.useState<string | null>(null);
    desiredUrlRef.current = desiredUrl;

    // Injected full in-page devtools (console/network/resources/storage) without CDP: the canonical
    // collector is injected as the Wry document-start init script at open (it re-runs natively on every
    // navigation), and posts its batched envelopes back over `window.ipc.postMessage`. The native host
    // buffers them; we drain on each poll tick and parse against the identity captured at injection time
    // (the runtime may rotate the live diagnostics bridge across navigations, so parsing against the
    // injected identity keeps drained events bound correctly).
    const propsDiagnosticsRef = React.useRef<BrowserDiagnosticsEngineBridgeConfig | null | undefined>(props.diagnostics);
    propsDiagnosticsRef.current = props.diagnostics;
    const injectedDiagnosticsRef = React.useRef<BrowserDiagnosticsEngineBridgeConfig | null>(null);
    const lastInjectedCollectorIdRef = React.useRef<string | null>(null);
    // A5c (F9-collector): the immediately-prior injected collector identity (generation N-1). The
    // Wry document-start script bakes the OPEN-time identity and re-runs natively on navigation, so
    // early post-navigation events can still be tagged with the prior generation. Keeping the prior
    // identity lets the drain accept generation N AND N-1 during the navigation window instead of
    // dropping those early events as `collector_mismatch`. Reset on a fresh open (no prior window).
    const priorInjectedDiagnosticsRef = React.useRef<BrowserDiagnosticsEngineBridgeConfig | null>(null);

    const buildDiagnosticsInitScript = React.useCallback((diagnostics: BrowserDiagnosticsEngineBridgeConfig): string => (
        buildInjectedBrowserDiagnosticsScript({
            browserSessionId: diagnostics.browserSessionId,
            viewId: diagnostics.viewId,
            navigationGeneration: diagnostics.navigationGeneration,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            desktopIpcDelivery: true,
            ownerConsoleValueCapture: diagnostics.consoleValueCapture === true,
            ownerDiagnosticsValueCapture: diagnostics.valueCapture === true,
        })
    ), []);

    const drainInjectedDiagnostics = React.useCallback(async () => {
        const diagnostics = injectedDiagnosticsRef.current;
        if (!diagnostics) return;
        const result = await bridge.drainDiagnostics(commandTarget);
        if (!result.ok || result.messages.length === 0) return;
        const collectorIdentity = (config: BrowserDiagnosticsEngineBridgeConfig) => ({
            browserSessionId: config.browserSessionId,
            viewId: config.viewId,
            navigationGeneration: config.navigationGeneration,
            collectorId: config.collectorId,
            nonce: config.nonce,
        });
        const identity = collectorIdentity(diagnostics);
        // A5c (F9-collector): accept the live collector (generation N) AND the immediately-prior one
        // (N-1) during a navigation window, so early post-navigation events tagged with the prior
        // collector are not dropped as `collector_mismatch`/`navigation_stale`. The current identity
        // is always tried first; the prior is a fallback only when it differs.
        const prior = priorInjectedDiagnosticsRef.current;
        const priorIdentity = prior && prior.collectorId !== diagnostics.collectorId
            ? collectorIdentity(prior)
            : null;
        const sanitizeOptions = {
            consoleValueCapture: diagnostics.consoleValueCapture === true,
            valueCapture: diagnostics.valueCapture === true,
        };
        for (const message of result.messages) {
            let parsed = parseInjectedBrowserDiagnosticsMessage(message, identity, sanitizeOptions);
            if (!parsed.ok && priorIdentity) {
                parsed = parseInjectedBrowserDiagnosticsMessage(message, priorIdentity, sanitizeOptions);
            }
            if (!parsed.ok) continue;
            // Early `continue` after each branch narrows the discriminated result union by elimination
            // (mirrors NativeWebViewEngine's message dispatch).
            if (parsed.events) { diagnostics.onEvents(parsed.events); continue; }
            if (parsed.evalResult) { diagnostics.onEvalResult?.(parsed.evalResult); continue; }
            if (parsed.propertiesResult) { diagnostics.onPropertiesResult?.(parsed.propertiesResult); continue; }
            if (parsed.releaseResult) { diagnostics.onReleaseObjectGroupResult?.(parsed.releaseResult); continue; }
            if (parsed.elementPickerResult) { diagnostics.onElementPickerResult?.(parsed.elementPickerResult); continue; }
        }
    }, [bridge, commandTarget]);
    const drainInjectedDiagnosticsRef = React.useRef(drainInjectedDiagnostics);
    drainInjectedDiagnosticsRef.current = drainInjectedDiagnostics;

    const emitDiagnosticsUnavailable = React.useCallback((reasonCode: string) => {
        const diagnostics = props.diagnostics;
        if (!diagnostics) return;
        pageInfoSequenceRef.current += 1;
        diagnostics.onEvents([
            createNativeWebViewUnavailableDiagnosticEvent({
                eventId: [
                    diagnostics.collectorId,
                    diagnostics.navigationGeneration,
                    'desktopPageInfo',
                    pageInfoSequenceRef.current,
                ].join(':'),
                browserSessionId: diagnostics.browserSessionId,
                viewId: diagnostics.viewId,
                navigationGeneration: diagnostics.navigationGeneration,
                capturedAtMs: props.nowMs?.() ?? Date.now(),
                unavailableReason: 'collector_unavailable',
                errorCode: reasonCode,
            }),
        ]);
    }, [props.diagnostics, props.nowMs]);
    const markNativeViewUnavailable = React.useCallback((reasonCode: string) => {
        setUnavailableReason(reasonCode);
        emitDiagnosticsUnavailable(reasonCode);
        // B-2 cause-2: a failed native open/navigate command is a load failure for the reducer too,
        // so the view leaves `loading` rather than spinning on a silently-swallowed Wry error.
        onLifecycleRef.current?.({ kind: 'loadFailed', errorCode: reasonCode });
    }, [emitDiagnosticsUnavailable]);
    const markNativeViewUnavailableRef = React.useRef(markNativeViewUnavailable);
    markNativeViewUnavailableRef.current = markNativeViewUnavailable;

    const publishPageInfo = React.useCallback(async () => {
        const diagnostics = props.diagnostics;
        const result = await bridge.readPageInfo(commandTarget);
        if (!result.ok || !result.pageInfo) {
            const reasonCode = firstDisabledReason(result);
            if (reasonCode) {
                emitDiagnosticsUnavailable(reasonCode);
            }
            return;
        }
        if (isPageInfoCrashed(result.pageInfo.loadingState)) {
            setCrashedUrl(result.pageInfo.currentUrl ?? result.pageInfo.requestedUrl);
        } else {
            setCrashedUrl(null);
        }
        // B-2 cause-2: feed the native load lifecycle back to the control reducer (independent of
        // whether a diagnostics bridge is attached) so the view leaves `loading`.
        const lifecycleSignal = desktopPageInfoLifecycleSignal(result.pageInfo);
        if (lifecycleSignal) {
            onLifecycleRef.current?.(lifecycleSignal);
        }
        if (!diagnostics) return;
        if (
            result.pageInfo.browserSessionId !== diagnostics.browserSessionId
            || result.pageInfo.viewId !== diagnostics.viewId
        ) {
            emitDiagnosticsUnavailable('desktop_webview_native_contract_invalid');
            return;
        }
        pageInfoSequenceRef.current += 1;
        diagnostics.onEvents([
            createNativeWebViewPageInfoDiagnosticEvent({
                eventId: [
                    diagnostics.collectorId,
                    diagnostics.navigationGeneration,
                    'desktopPageInfo',
                    pageInfoSequenceRef.current,
                ].join(':'),
                browserSessionId: diagnostics.browserSessionId,
                viewId: diagnostics.viewId,
                navigationGeneration: diagnostics.navigationGeneration,
                capturedAtMs: props.nowMs?.() ?? Date.now(),
                url: result.pageInfo.currentUrl ?? result.pageInfo.requestedUrl,
                loading: isPageInfoLoading(result.pageInfo.loadingState),
                title: result.pageInfo.title,
            }),
        ]);
    }, [bridge, commandTarget, emitDiagnosticsUnavailable, props.diagnostics, props.nowMs]);
    const publishPageInfoRef = React.useRef(publishPageInfo);
    publishPageInfoRef.current = publishPageInfo;

    React.useEffect(() => {
        const openUrl = desiredUrlRef.current;
        if (!openUrl) {
            markNativeViewUnavailableRef.current('external_url_unavailable');
            return undefined;
        }

        let disposed = false;
        lastRequestedUrlRef.current = openUrl;
        setUnavailableReason(null);

        // Inject the canonical diagnostics collector at document-start (when diagnostics are enabled),
        // and capture the identity it was built with so drained envelopes parse against it.
        const diagnostics = propsDiagnosticsRef.current ?? null;
        injectedDiagnosticsRef.current = diagnostics;
        // A fresh open opens no prior-generation window: there is no earlier in-page collector whose
        // late events could still be in flight.
        priorInjectedDiagnosticsRef.current = null;
        lastInjectedCollectorIdRef.current = diagnostics?.collectorId ?? null;
        const diagnosticsInitScript = diagnostics ? buildDiagnosticsInitScript(diagnostics) : undefined;

        bridge.openView({
            ...commandTarget,
            profileId: props.profileId,
            url: openUrl,
            ...(diagnosticsInitScript ? { diagnosticsInitScript } : {}),
        }).then((result) => {
            if (disposed) return;
            if (!result.ok) {
                markNativeViewUnavailableRef.current(firstDisabledReason(result) ?? 'desktop_webview_native_command_unavailable');
                return;
            }
            void publishPageInfoRef.current();
            void drainInjectedDiagnosticsRef.current();
        }).catch(() => {
            if (!disposed) {
                markNativeViewUnavailableRef.current('desktop_webview_native_command_unavailable');
            }
        });

        return () => {
            disposed = true;
            lastRequestedUrlRef.current = null;
            // The native view lifetime (hide vs close) is owned by `useDesktopWebViewSurfaceSync`:
            // a hidden/parked lifecycle keeps it mounted and a genuine teardown closes it. The open
            // effect therefore no longer unconditionally closes on every unmount/re-open. Re-open
            // (a viewKey change) is handled natively — `open_view` replaces and drops the old view.
        };
    }, [bridge, buildDiagnosticsInitScript, commandTarget, props.profileId, viewKey]);

    React.useEffect(() => {
        // Harden (§15 Δ2): only skip when the URL is genuinely unchanged. The previous
        // `lastRequestedUrlRef.current == null` clause silently SWALLOWED a same-viewKey in-place URL
        // set (the open effect runs FIRST on mount and seeds the ref, so dropping that clause never
        // double-loads, but it no longer drops a real navigation when the ref was reset/never seeded).
        if (!desiredUrl || lastRequestedUrlRef.current === desiredUrl) {
            return;
        }
        lastRequestedUrlRef.current = desiredUrl;
        bridge.navigateView({
            ...commandTarget,
            url: desiredUrl,
        }).then((result) => {
            if (!result.ok) {
                markNativeViewUnavailable(firstDisabledReason(result) ?? 'desktop_webview_native_command_unavailable');
                return;
            }
            void publishPageInfo();
            void drainInjectedDiagnosticsRef.current();
        }).catch(() => {
            markNativeViewUnavailable('desktop_webview_native_command_unavailable');
        });
    }, [bridge, commandTarget, desiredUrl, markNativeViewUnavailable, publishPageInfo]);

    // B-2 cause-2 completion: the native page-info poll drives the control-reducer lifecycle
    // (loading → ready/failed), the in-place URL/title sync after an in-webview link navigation,
    // render-crash detection, and native-devtools availability — none of which depend on a
    // diagnostics bridge. Gating this poll on `props.diagnostics` (its original diagnostics-only
    // purpose) left a desktop view with diagnostics unavailable stuck on a permanent spinner: the
    // single post-open `publishPageInfo` reports `loading`, and with no further poll the view never
    // reaches `ready` (so the toolbar reload stays a disabled "stop" and link clicks never settle).
    // Poll whenever the native view is active; `publishPageInfo` already self-skips diagnostics
    // emission when no bridge is attached.
    const pageInfoPollActive = !!desiredUrl && !unavailableReason;
    React.useEffect(() => {
        const intervalMs = props.pageInfoPollIntervalMs === undefined ? 2_000 : props.pageInfoPollIntervalMs;
        if (!pageInfoPollActive || !intervalMs || intervalMs <= 0) {
            return undefined;
        }
        const timer = setInterval(() => {
            void publishPageInfo();
            void drainInjectedDiagnosticsRef.current();
        }, intervalMs);
        return () => {
            clearInterval(timer);
        };
    }, [pageInfoPollActive, props.pageInfoPollIntervalMs, publishPageInfo]);

    // Keep the in-page collector synced to the live diagnostics identity. The first injection is the
    // document-start init script set at open; a later identity rotation (a navigation bumps the
    // navigationGeneration → a fresh collectorId) re-injects the collector via eval so both the
    // drained events and the interactive command scripts bind to the same in-page collector.
    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        if (!diagnostics || !desiredUrl || unavailableReason) return;
        if (lastInjectedCollectorIdRef.current === diagnostics.collectorId) {
            injectedDiagnosticsRef.current = diagnostics;
            return;
        }
        // Collector identity rotated (a navigation bumped the generation → a fresh collectorId).
        // Remember the outgoing identity as the prior generation so the drain still accepts the
        // early post-navigation events the previous in-page collector may still emit (A5c).
        priorInjectedDiagnosticsRef.current = injectedDiagnosticsRef.current;
        injectedDiagnosticsRef.current = diagnostics;
        lastInjectedCollectorIdRef.current = diagnostics.collectorId;
        void bridge.evalScript({ ...commandTarget, script: buildDiagnosticsInitScript(diagnostics) });
    }, [bridge, buildDiagnosticsInitScript, commandTarget, desiredUrl, props.diagnostics, unavailableReason]);

    // Interactive eval REPL: push the canonical eval command script into the page; its result returns
    // over the ipc/drain channel and is dispatched to `onEvalResult` by `drainInjectedDiagnostics`.
    const evalRequest = props.diagnostics?.evalRequest;
    React.useEffect(() => {
        const diagnostics = injectedDiagnosticsRef.current;
        if (!diagnostics || !evalRequest || !desiredUrl || unavailableReason) return;
        void bridge.evalScript({
            ...commandTarget,
            script: buildInjectedBrowserDiagnosticsEvalCommandScript({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: evalRequest,
            }),
        });
    }, [bridge, commandTarget, desiredUrl, evalRequest, unavailableReason]);

    // Interactive object-property / release / element-picker command scripts (same channel).
    const getPropertiesRequest = props.diagnostics?.getPropertiesRequest;
    const releaseObjectGroupRequest = props.diagnostics?.releaseObjectGroupRequest;
    const elementPickerRequest = props.diagnostics?.elementPickerRequest;
    React.useEffect(() => {
        const diagnostics = injectedDiagnosticsRef.current;
        if (!diagnostics || !desiredUrl || unavailableReason) return;
        if (getPropertiesRequest) {
            void bridge.evalScript({
                ...commandTarget,
                script: buildInjectedBrowserDiagnosticsGetPropertiesCommandScript({
                    browserSessionId: diagnostics.browserSessionId,
                    collectorId: diagnostics.collectorId,
                    nonce: diagnostics.nonce,
                    version: diagnostics.collectorVersion,
                    request: getPropertiesRequest,
                }),
            });
        }
        if (releaseObjectGroupRequest) {
            void bridge.evalScript({
                ...commandTarget,
                script: buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript({
                    browserSessionId: diagnostics.browserSessionId,
                    collectorId: diagnostics.collectorId,
                    nonce: diagnostics.nonce,
                    version: diagnostics.collectorVersion,
                    request: releaseObjectGroupRequest,
                }),
            });
        }
        if (elementPickerRequest) {
            void bridge.evalScript({
                ...commandTarget,
                script: buildInjectedBrowserDiagnosticsElementPickerCommandScript({
                    browserSessionId: diagnostics.browserSessionId,
                    collectorId: diagnostics.collectorId,
                    nonce: diagnostics.nonce,
                    version: diagnostics.collectorVersion,
                    request: elementPickerRequest,
                }),
            });
        }
    }, [bridge, commandTarget, desiredUrl, elementPickerRequest, getPropertiesRequest, releaseObjectGroupRequest, unavailableReason]);

    const navigationCommandKind = props.navigationCommand?.kind;
    const navigationCommandId = props.navigationCommand?.commandId;
    // A5b (F11): inject reload/stop exactly once per command id. The bridge and command target are
    // held in refs and read by a SINGLE stable callback, so a later bridge/target change is always
    // picked up (the previous code rebuilt the ref's closure on every render — wasteful, and the
    // initially-stored closure was dead). The stable identity also keeps the dispatch effect keyed
    // purely on the command id/kind, so unrelated re-renders never re-fire it (goBack/goForward are
    // not injection-reachable for the desktop engine and stay out of scope here).
    const bridgeRef = React.useRef(bridge);
    bridgeRef.current = bridge;
    const dispatchNavigationCommandTargetRef = React.useRef(commandTarget);
    dispatchNavigationCommandTargetRef.current = commandTarget;
    const dispatchNavigation = React.useCallback((kind: 'reload' | 'stop') => {
        void bridgeRef.current.dispatchNavigation({
            ...dispatchNavigationCommandTargetRef.current,
            kind,
            script: buildInjectedNavigationScript(kind),
        });
    }, []);
    React.useEffect(() => {
        if (!navigationCommandId || (navigationCommandKind !== 'reload' && navigationCommandKind !== 'stop')) {
            return;
        }
        dispatchNavigation(navigationCommandKind);
    }, [dispatchNavigation, navigationCommandId, navigationCommandKind]);

    const measuredRectRef = React.useRef<DesktopWebViewSurfaceRect | null>(null);
    const setContainerRef = React.useCallback((node: React.ElementRef<typeof View> | null) => {
        containerRef.current = node;
    }, []);

    // Synchronous rect source for the rAF-driven sync loop. On the desktop (Tauri/web) runtime the
    // container ref resolves to a DOM node whose `getBoundingClientRect()` gives window-space bounds
    // each frame; `measureInWindow` is kept as the fallback rect source (and primes the cache off the
    // main thread), so the loop always has a last-known rect even before the first DOM read.
    const measureRect = React.useCallback((): DesktopWebViewSurfaceRect | null => {
        const node = containerRef.current as unknown as {
            getBoundingClientRect?: () => { x: number; y: number; left: number; top: number; width: number; height: number };
            measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } | null;
        if (node?.getBoundingClientRect) {
            const domRect = node.getBoundingClientRect();
            const rect: DesktopWebViewSurfaceRect = {
                x: domRect.x ?? domRect.left,
                y: domRect.y ?? domRect.top,
                width: domRect.width,
                height: domRect.height,
                scaleFactor: 1,
            };
            measuredRectRef.current = rect;
            return rect;
        }
        if (node?.measureInWindow) {
            node.measureInWindow((x, y, width, height) => {
                measuredRectRef.current = { x, y, width, height, scaleFactor: 1 };
            });
        }
        return measuredRectRef.current;
    }, []);

    const surfaceSync = useDesktopWebViewSurfaceSync({
        bridge,
        commandTarget,
        active: !!desiredUrl && !unavailableReason,
        lifecycleState: props.lifecycleState,
        measureRect,
        occlusionProbe: props.occlusionProbe,
        dragSignal: props.dragSignal,
    });
    const requestBoundsSync = surfaceSync.requestSync;

    // Reload-after-crash: re-issue navigation to the last good URL through the same native command
    // the engine already uses, clear the crashed surface optimistically, and re-poll page-info so a
    // successful reload restores the live view. No eval/injection — this is the trusted nav seam.
    const reloadAfterCrash = React.useCallback(() => {
        const reloadUrl = crashedUrl ?? desiredUrlRef.current;
        if (!reloadUrl) return;
        setCrashedUrl(null);
        lastRequestedUrlRef.current = reloadUrl;
        bridge.navigateView({
            ...commandTarget,
            url: reloadUrl,
        }).then((result) => {
            if (!result.ok) {
                markNativeViewUnavailable(firstDisabledReason(result) ?? 'desktop_webview_native_command_unavailable');
                return;
            }
            void publishPageInfo();
        }).catch(() => {
            markNativeViewUnavailable('desktop_webview_native_command_unavailable');
        });
    }, [bridge, commandTarget, crashedUrl, markNativeViewUnavailable, publishPageInfo]);

    if (!desiredUrl || unavailableReason) {
        return (
            <BrowserFrameUnavailable
                testID={props.testID}
                reasonCode={unavailableReason ?? 'external_url_unavailable'}
            />
        );
    }

    if (crashedUrl) {
        return (
            <View testID={`${props.testID}-crashed`} style={stylesheet.crashedContainer}>
                <Text style={browserFrameStyles.statusText}>
                    {t('browserShell.status.crashed')}
                </Text>
                <Pressable
                    testID={`${props.testID}-crashed-reload`}
                    accessibilityRole="button"
                    accessibilityLabel={t('browserShell.toolbar.reloadAfterCrash')}
                    onPress={reloadAfterCrash}
                    style={stylesheet.crashedReloadButton}
                >
                    <Ionicons
                        name="refresh-outline"
                        size={18}
                        color={theme.colors.text.primary}
                    />
                    <Text style={browserFrameStyles.statusText}>
                        {t('browserShell.toolbar.reloadAfterCrash')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    // A5a (F1-ui): the engine no longer renders its own devtools button. It was absolutely
    // positioned over the native Wry child view (which paints on top), so it was permanently
    // occluded and never clickable. Devtools has a single owner — the `BrowserShell` toolbar.
    return (
        <View
            ref={setContainerRef}
            testID={props.testID}
            style={stylesheet.root}
            onLayout={requestBoundsSync}
        />
    );
}
