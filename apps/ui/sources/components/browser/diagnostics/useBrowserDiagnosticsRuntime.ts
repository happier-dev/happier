import * as React from 'react';

import type {
    BrowserDiagnosticsElementPickerRequestV1,
    BrowserDiagnosticsElementPickerResultV1,
    BrowserDiagnosticsEvalRequestV1,
    BrowserDiagnosticsEvalResultV1,
    BrowserDiagnosticsGetPropertiesRequestV1,
    BrowserDiagnosticsGetPropertiesResultV1,
    BrowserDiagnosticsReleaseObjectGroupRequestV1,
    BrowserDiagnosticsReleaseObjectGroupResultV1,
} from '@happier-dev/protocol';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type {
    BrowserDiagnosticsEvalConsoleControls,
    BrowserDiagnosticsEvalConsoleEntry,
    BrowserDiagnosticsObjectInspectorEntry,
} from './BrowserDiagnosticsEvalConsole';
import {
    applyBrowserDiagnosticEvents,
    createBrowserDiagnosticsUiStore,
    type BrowserDiagnosticsSnapshotClient,
    type BrowserDiagnosticsUiStore,
    useBrowserDiagnosticsDaemonSnapshot,
} from '@/sync/domains/browser/diagnostics';

import type { BrowserDiagnosticsEngineBridgeConfig } from '../frame/types';
import type { BrowserDiagnosticsInteractionControls } from './BrowserDiagnosticsInteractionPanel';

const DEFAULT_COLLECTOR_VERSION = '1.0.0';

type BrowserDiagnosticsBridgeBaseConfig = Omit<
    BrowserDiagnosticsEngineBridgeConfig,
    | 'evalRequest'
    | 'getPropertiesRequest'
    | 'releaseObjectGroupRequest'
    | 'elementPickerRequest'
    | 'onEvalResult'
    | 'onPropertiesResult'
    | 'onReleaseObjectGroupResult'
    | 'onElementPickerResult'
>;

type BrowserDiagnosticsPendingRequests = Readonly<{
    evalRequest?: BrowserDiagnosticsEvalRequestV1;
    getPropertiesRequest?: BrowserDiagnosticsGetPropertiesRequestV1;
    releaseObjectGroupRequest?: BrowserDiagnosticsReleaseObjectGroupRequestV1;
    elementPickerRequest?: BrowserDiagnosticsElementPickerRequestV1;
}>;

export type BrowserDiagnosticsEvalCommandInput = Readonly<{
    expression: string;
    timeoutMs?: number;
    objectGroupId?: string;
}>;

export type BrowserDiagnosticsGetPropertiesCommandInput = Readonly<{
    objectId: string;
    objectGroupId: string;
}>;

export type BrowserDiagnosticsReleaseObjectGroupCommandInput = Readonly<{
    objectGroupId: string;
}>;

export type BrowserDiagnosticsRuntimeProjection = Readonly<{
    state: BrowserDiagnosticsUiStore;
    bridge?: BrowserDiagnosticsEngineBridgeConfig | null;
    interaction?: BrowserDiagnosticsInteractionControls;
    requestEval: (input: BrowserDiagnosticsEvalCommandInput) => boolean;
    requestGetProperties: (input: BrowserDiagnosticsGetPropertiesCommandInput) => boolean;
    requestReleaseObjectGroup: (input: BrowserDiagnosticsReleaseObjectGroupCommandInput) => boolean;
}>;

export type UseBrowserDiagnosticsRuntimeInput = Readonly<{
    view: BrowserControlViewState | null;
    enabled?: boolean;
    parentOrigin?: string | null;
    collectorVersion?: string;
    daemonSnapshotServerId?: string | null;
    daemonSnapshotRefreshIntervalMs?: number | null;
    daemonSnapshotClient?: BrowserDiagnosticsSnapshotClient;
    /**
     * DEV-2: the LOCAL owner's `browser.diagnostics` value-capture policy. The injected engine bridge
     * is the local owner present on this device, so this defaults to `true` (full console fidelity for
     * the owner — plan rule #3, full features, no over-gating). The host may set it to `false` to keep
     * console text metadata-only. Agent/remote egress is always redacted by the egress classifier SSOT
     * (`INJECTED_OWNER_ONLY_FIELDS`), independent of this local-owner policy.
     */
    consoleValueCapture?: boolean;
    /**
     * Phase 4.2(d) bridge: invoked with the raw picker result whenever the element picker resolves.
     * The host wires this to the annotation adapter so a selected element flows into a
     * `captureElement` annotation (element-picker and annotation become one feature).
     */
    onElementPickerResult?: (result: BrowserDiagnosticsElementPickerResultV1) => void;
}>;

function normalizeHttpOrigin(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
        return null;
    }
}

function createCryptoToken(): string | null {
    const random = globalThis.crypto?.randomUUID?.();
    if (random) {
        return random;
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (!bytes.some((byte) => byte !== 0)) {
        return null;
    }
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function defaultParentOrigin(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }
    return normalizeHttpOrigin(window.location?.origin);
}

function canAttachInjectedDiagnostics(view: BrowserControlViewState): boolean {
    const supportedAdapter = view.adapterKind === 'localPreview' || view.adapterKind === 'hostedPlugin';
    // Native WebView owns an actual `injectedJavaScript` channel. Web iframes only have a
    // postMessage listener in the host; without a production script-injection owner in the preview /
    // hosted-web response path, exposing a bridge would advertise unsupported diagnostics and render
    // a fake "Unavailable" devtools drawer.
    return supportedAdapter && view.engineKind === 'nativeWebView';
}

/**
 * Desktop Wry (WebKit) exposes no CDP, but it DOES honor script injection + a `window.ipc` return
 * channel, so the desktop engine injects the canonical collector as a document-start init script and
 * drains its `window.ipc.postMessage` envelopes (full in-page console/network/resource/storage
 * devtools — no sidecar needed). Attaching a bridge for the desktop engine gives the engine the
 * collector identity it injects with and routes the drained events into the diagnostics store.
 * Interactive eval/element-picker is wired separately (it needs a host eval command to push the
 * command scripts into the page).
 */
function canAttachDesktopInjectedDiagnostics(view: BrowserControlViewState): boolean {
    return view.engineKind === 'desktopWebView' && view.adapterKind === 'externalUrl';
}

function defaultObjectGroupId(view: BrowserControlViewState): string {
    return `browser_diagnostics:${view.viewId}:${view.navigationGeneration}`;
}

function runtimeViewKey(view: BrowserControlViewState | null): string | null {
    return view
        ? `${view.browserSessionId}:${view.viewId}:${view.navigationGeneration}:${view.adapterKind}:${view.engineKind}:${view.currentUrl ?? ''}:${view.securityOrigin ?? ''}`
        : null;
}

export function useBrowserDiagnosticsRuntime(
    input: UseBrowserDiagnosticsRuntimeInput,
): BrowserDiagnosticsRuntimeProjection | null {
    const [state, setState] = React.useState<BrowserDiagnosticsUiStore>(() => createBrowserDiagnosticsUiStore());
    const [interactionEnabled, setInteractionEnabled] = React.useState(false);
    const [pickerActive, setPickerActive] = React.useState(false);
    const [pendingRequests, setPendingRequests] = React.useState<BrowserDiagnosticsPendingRequests>({});
    // DEV-3/DEV-4: the local-owner eval REPL results + expandable object-inspector tree. The runtime
    // historically discarded eval/getProperties results; they are now stored, keyed within the
    // active navigation-generation object group, and released on navigation/clear.
    const [evalEntries, setEvalEntries] = React.useState<readonly BrowserDiagnosticsEvalConsoleEntry[]>([]);
    const [objectProperties, setObjectProperties] = React.useState<
        Readonly<Record<string, BrowserDiagnosticsObjectInspectorEntry>>
    >({});
    const requestOrdinalRef = React.useRef(0);
    const viewKey = runtimeViewKey(input.view);
    // The injected engine bridge is the local owner present on this device; full console fidelity is
    // the local-owner default (plan rule #3). Agent/remote egress is redacted by the classifier SSOT.
    const valueCapture = input.consoleValueCapture ?? true;

    const onEvents = React.useCallback<BrowserDiagnosticsEngineBridgeConfig['onEvents']>((events) => {
        setState((current) => applyBrowserDiagnosticEvents(current, {
            events,
            consoleValueCapture: valueCapture,
            valueCapture,
        }));
    }, [valueCapture]);

    useBrowserDiagnosticsDaemonSnapshot({
        view: input.view,
        enabled: input.enabled === true,
        serverId: input.daemonSnapshotServerId,
        refreshIntervalMs: input.daemonSnapshotRefreshIntervalMs,
        snapshotClient: input.daemonSnapshotClient,
        onEvents,
    });

    React.useEffect(() => {
        setInteractionEnabled(false);
        setPickerActive(false);
        setPendingRequests({});
        // Navigation/clear: the page's remote objects belong to the prior generation's object group
        // and are gone — drop any stored console results + expanded properties so nothing leaks across
        // navigation generations.
        setEvalEntries([]);
        setObjectProperties({});
    }, [viewKey]);

    const bridgeBase = React.useMemo<BrowserDiagnosticsBridgeBaseConfig | null>(() => {
        const view = input.view;
        if (input.enabled !== true || !view) {
            return null;
        }
        const injected = canAttachInjectedDiagnostics(view);
        // Desktop injection (Wry ipc transport) when the standard injected surfaces do not apply.
        const desktopInjected = !injected && canAttachDesktopInjectedDiagnostics(view);
        if (!injected && !desktopInjected) {
            return null;
        }

        const sourceOrigin = normalizeHttpOrigin(view.securityOrigin) ?? normalizeHttpOrigin(view.currentUrl);
        const parentOrigin = normalizeHttpOrigin(input.parentOrigin) ?? defaultParentOrigin();
        if (injected && view.engineKind === 'webIframe' && (!sourceOrigin || !parentOrigin)) {
            return null;
        }

        const collectorToken = createCryptoToken();
        const nonce = createCryptoToken();
        if (!collectorToken || !nonce) {
            return null;
        }

        return {
            browserSessionId: view.browserSessionId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            collectorId: `browser_diagnostics:${view.viewId}:${view.navigationGeneration}:${collectorToken}`,
            nonce,
            collectorVersion: input.collectorVersion ?? DEFAULT_COLLECTOR_VERSION,
            // The web/iframe origin handshake is meaningless for the desktop Wry channel (it delivers
            // over `window.ipc`, not parent postMessage), so it stays unset for desktop bridges.
            sourceOrigin: injected ? (sourceOrigin ?? undefined) : undefined,
            webPostMessageTargetOrigin: injected ? (parentOrigin ?? undefined) : undefined,
            consoleValueCapture: valueCapture,
            valueCapture,
            onEvents,
        };
    }, [
        input.collectorVersion,
        input.enabled,
        input.parentOrigin,
        input.view,
        valueCapture,
        onEvents,
    ]);

    // Interactive diagnostics (eval / element-picker) push command scripts INTO the page. Native
    // WebView injected surfaces deliver them through their bridge; the desktop engine evals them via
    // the host `desktop_browser_eval_script` command (results return over the same ipc/drain channel).
    // Web iframes are intentionally not listed here until a real script-injection owner exists.
    const interactionSupported = input.enabled === true
        && !!input.view
        && (canAttachInjectedDiagnostics(input.view) || canAttachDesktopInjectedDiagnostics(input.view));

    const nextRequestId = React.useCallback((prefix: string): string | null => {
        const view = input.view;
        if (!view) return null;
        requestOrdinalRef.current += 1;
        return `${prefix}:${view.viewId}:${view.navigationGeneration}:${requestOrdinalRef.current}`;
    }, [input.view]);

    const getInteractiveView = React.useCallback((): BrowserControlViewState | null => {
        if (input.enabled !== true || !interactionEnabled || !bridgeBase || !interactionSupported) return null;
        return input.view;
    }, [bridgeBase, input, interactionEnabled, interactionSupported]);

    const requestEval = React.useCallback((requestInput: BrowserDiagnosticsEvalCommandInput): boolean => {
        const view = getInteractiveView();
        if (!view) return false;
        const evalRequestId = nextRequestId('eval');
        if (!evalRequestId) return false;

        const objectGroupId = requestInput.objectGroupId ?? defaultObjectGroupId(view);
        const request: BrowserDiagnosticsEvalRequestV1 = {
            v: 1,
            evalRequestId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage',
            expression: requestInput.expression,
            timeoutMs: requestInput.timeoutMs ?? 2_000,
            objectGroupId,
            diagnosticsInteractionEnabled: true,
        };
        // Record a pending console entry so the local owner sees the in-flight expression immediately;
        // `handleEvalResult` resolves it in place when the result arrives (DEV-3).
        setEvalEntries((current) => [
            ...current,
            { evalRequestId, expression: requestInput.expression, objectGroupId, status: 'pending' },
        ]);
        setPendingRequests((current) => ({ ...current, evalRequest: request }));
        return true;
    }, [getInteractiveView, nextRequestId]);

    const requestGetProperties = React.useCallback((requestInput: BrowserDiagnosticsGetPropertiesCommandInput): boolean => {
        const view = getInteractiveView();
        if (!view) return false;
        const propertyRequestId = nextRequestId('properties');
        if (!propertyRequestId) return false;

        const request: BrowserDiagnosticsGetPropertiesRequestV1 = {
            v: 1,
            propertyRequestId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage',
            objectId: requestInput.objectId,
            objectGroupId: requestInput.objectGroupId,
            diagnosticsInteractionEnabled: true,
        };
        setPendingRequests((current) => ({ ...current, getPropertiesRequest: request }));
        return true;
    }, [getInteractiveView, nextRequestId]);

    const requestReleaseObjectGroup = React.useCallback((requestInput: BrowserDiagnosticsReleaseObjectGroupCommandInput): boolean => {
        const view = getInteractiveView();
        if (!view) return false;
        const releaseRequestId = nextRequestId('release');
        if (!releaseRequestId) return false;

        const request: BrowserDiagnosticsReleaseObjectGroupRequestV1 = {
            v: 1,
            releaseRequestId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage',
            objectGroupId: requestInput.objectGroupId,
            diagnosticsInteractionEnabled: true,
        };
        setPendingRequests((current) => ({ ...current, releaseObjectGroupRequest: request }));
        return true;
    }, [getInteractiveView, nextRequestId]);

    const startElementPicker = React.useCallback(() => {
        const view = getInteractiveView();
        if (!view) return;
        const pickerRequestId = nextRequestId('picker');
        if (!pickerRequestId) return;

        const request: BrowserDiagnosticsElementPickerRequestV1 = {
            v: 1,
            pickerRequestId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage',
            action: 'start',
            diagnosticsInteractionEnabled: true,
        };
        setPickerActive(true);
        setPendingRequests((current) => ({ ...current, elementPickerRequest: request }));
    }, [getInteractiveView, nextRequestId]);

    const cancelElementPicker = React.useCallback(() => {
        const view = getInteractiveView();
        if (!view) return;
        const pickerRequestId = nextRequestId('picker');
        if (!pickerRequestId) return;

        const request: BrowserDiagnosticsElementPickerRequestV1 = {
            v: 1,
            pickerRequestId,
            viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage',
            action: 'cancel',
            diagnosticsInteractionEnabled: true,
        };
        setPendingRequests((current) => ({ ...current, elementPickerRequest: request }));
    }, [getInteractiveView, nextRequestId]);

    const handleEvalResult = React.useCallback((result: BrowserDiagnosticsEvalResultV1) => {
        setPendingRequests((current) => (
            current.evalRequest?.evalRequestId === result.evalRequestId ? (() => {
                const { evalRequest: _evalRequest, ...next } = current;
                return next;
            })() : current
        ));
        // DEV-3: store the result on its console entry instead of discarding it.
        setEvalEntries((current) => current.map((entry) => (
            entry.evalRequestId === result.evalRequestId
                ? {
                    ...entry,
                    status: result.status,
                    ...(result.result ? { result: result.result } : {}),
                    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
                }
                : entry
        )));
    }, []);

    const expandObject = React.useCallback((objectId: string, objectGroupId: string): boolean => {
        // Mark the node loading first so the inspector renders a spinner even if the request is async.
        setObjectProperties((current) => ({
            ...current,
            [objectId]: { status: 'loading', properties: [] },
        }));
        const dispatched = requestGetProperties({ objectId, objectGroupId });
        if (!dispatched) {
            setObjectProperties((current) => ({
                ...current,
                [objectId]: { status: 'failed', properties: [], errorCode: 'collector_unavailable' },
            }));
        }
        return dispatched;
    }, [requestGetProperties]);

    const handlePropertiesResult = React.useCallback((result: BrowserDiagnosticsGetPropertiesResultV1) => {
        setPendingRequests((current) => (
            current.getPropertiesRequest?.propertyRequestId === result.propertyRequestId ? (() => {
                const { getPropertiesRequest: _getPropertiesRequest, ...next } = current;
                return next;
            })() : current
        ));
        // DEV-4: store the expanded properties keyed by objectId so the inspector tree renders them.
        setObjectProperties((current) => ({
            ...current,
            [result.objectId]: result.status === 'completed'
                ? { status: 'loaded', properties: result.properties }
                : { status: 'failed', properties: [], ...(result.errorCode ? { errorCode: result.errorCode } : {}) },
        }));
    }, []);

    const handleReleaseObjectGroupResult = React.useCallback((result: BrowserDiagnosticsReleaseObjectGroupResultV1) => {
        setPendingRequests((current) => (
            current.releaseObjectGroupRequest?.releaseRequestId === result.releaseRequestId ? (() => {
                const { releaseObjectGroupRequest: _releaseObjectGroupRequest, ...next } = current;
                return next;
            })() : current
        ));
    }, []);

    const onElementPickerResultBridge = input.onElementPickerResult;
    const handleElementPickerResult = React.useCallback((result: BrowserDiagnosticsElementPickerResultV1) => {
        setPendingRequests((current) => (
            current.elementPickerRequest?.pickerRequestId === result.pickerRequestId ? (() => {
                const { elementPickerRequest: _elementPickerRequest, ...next } = current;
                return next;
            })() : current
        ));
        if (result.status === 'selected' || result.status === 'cancelled' || result.status === 'blocked' || result.status === 'failed') {
            setPickerActive(false);
        }
        // Bridge a selected element to the host (→ annotation captureElement). Non-selected results
        // are forwarded too so the host can clear any pending picker UI; the host helper no-ops them.
        onElementPickerResultBridge?.(result);
    }, [onElementPickerResultBridge]);

    const bridge = React.useMemo<BrowserDiagnosticsEngineBridgeConfig | null>(() => {
        if (!bridgeBase) return null;
        return {
            ...bridgeBase,
            ...pendingRequests,
            onEvalResult: handleEvalResult,
            onPropertiesResult: handlePropertiesResult,
            onReleaseObjectGroupResult: handleReleaseObjectGroupResult,
            onElementPickerResult: handleElementPickerResult,
        };
    }, [
        bridgeBase,
        handleElementPickerResult,
        handleEvalResult,
        handlePropertiesResult,
        handleReleaseObjectGroupResult,
        pendingRequests,
    ]);

    const interaction = React.useMemo<BrowserDiagnosticsInteractionControls>(() => {
        if (!bridgeBase || !interactionSupported) {
            return {
                state: 'unavailable',
                ownerOnly: true,
                unavailableReasonCode: input.view && canAttachInjectedDiagnostics(input.view)
                    ? 'collector_unavailable'
                    : 'adapter_unavailable',
                pickerState: 'unavailable',
            };
        }
        if (!interactionEnabled) {
            return {
                state: 'disabled',
                ownerOnly: true,
                canEnable: true,
                pickerState: 'idle',
                onEnableInteraction: () => {
                    setInteractionEnabled(true);
                },
            };
        }
        const evalConsole: BrowserDiagnosticsEvalConsoleControls = {
            entries: evalEntries,
            objectProperties,
            onSubmitExpression: (expression) => requestEval({ expression }),
            onExpandObject: expandObject,
        };
        return {
            state: 'enabled',
            ownerOnly: true,
            pickerState: pickerActive ? 'active' : 'idle',
            evalConsole,
            onDisableInteraction: () => {
                // Release the live object group on the page, then clear local console/inspector state.
                const view = input.view;
                if (view) {
                    requestReleaseObjectGroup({ objectGroupId: defaultObjectGroupId(view) });
                }
                setInteractionEnabled(false);
                setPickerActive(false);
                setPendingRequests({});
                setEvalEntries([]);
                setObjectProperties({});
            },
            onStartElementPicker: startElementPicker,
            onCancelElementPicker: cancelElementPicker,
        };
    }, [
        bridgeBase,
        cancelElementPicker,
        evalEntries,
        expandObject,
        input.view,
        interactionEnabled,
        interactionSupported,
        objectProperties,
        pickerActive,
        requestEval,
        requestReleaseObjectGroup,
        startElementPicker,
    ]);

    if (input.enabled !== true || !input.view) {
        return null;
    }

    return {
        state,
        bridge,
        interaction,
        requestEval,
        requestGetProperties,
        requestReleaseObjectGroup,
    };
}
