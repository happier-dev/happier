import * as React from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';

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
    advanceBrowserDiagnosticsGeneration,
    applyBrowserDiagnosticEvents,
    createBrowserDiagnosticsUiStore,
    selectBrowserDiagnosticsEventCount,
    resolveBrowserDiagnosticsSnapshotMachineId,
    type BrowserDiagnosticsSnapshotClient,
    type BrowserDiagnosticsUiStore,
    type UseBrowserDiagnosticsDaemonSnapshotInput,
} from '@/sync/domains/browser/diagnostics';

import type { BrowserDiagnosticsEngineBridgeConfig } from '../frame/types';
import type { BrowserDiagnosticsInteractionControls } from './BrowserDiagnosticsInteractionPanel';
import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { BrowserRuntimeDiagnosticsAdapter } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { BrowserDiagnosticsEvalRequestV1Schema, BrowserDiagnosticsGetPropertiesRequestV1Schema,
    BrowserDiagnosticsReleaseObjectGroupRequestV1Schema, BrowserDiagnosticsElementPickerRequestV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

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

type PendingDiagnosticsResult = Readonly<{
    request: BrowserDiagnosticsPendingRequests;
    settle: (result: unknown) => void;
    dispose: () => void;
}>;

function projectPendingRequests(pending: Iterable<PendingDiagnosticsResult>): BrowserDiagnosticsPendingRequests {
    let next: BrowserDiagnosticsPendingRequests = {};
    for (const { request } of pending) {
        next = {
            evalRequest: next.evalRequest ?? request.evalRequest,
            getPropertiesRequest: next.getPropertiesRequest ?? request.getPropertiesRequest,
            releaseObjectGroupRequest: next.releaseObjectGroupRequest ?? request.releaseObjectGroupRequest,
            // Cancelling a picker must reach the engine while its start is still awaiting a selection.
            elementPickerRequest: request.elementPickerRequest?.action === 'cancel'
                ? request.elementPickerRequest : next.elementPickerRequest ?? request.elementPickerRequest,
        };
    }
    return next;
}

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
    eventSource?: Pick<StoreApi<BrowserDiagnosticsUiStore>, 'getState' | 'subscribe'>;
    hasRenderableDiagnostics?: boolean;
    /** The open drawer acquires this source; collectors continue independently while it is closed. */
    daemonSnapshot?: UseBrowserDiagnosticsDaemonSnapshotInput;
    bridge?: BrowserDiagnosticsEngineBridgeConfig | null;
    interaction?: BrowserDiagnosticsInteractionControls;
    runtimeAdapter?: BrowserRuntimeDiagnosticsAdapter;
    requestEval: (input: BrowserDiagnosticsEvalCommandInput) => boolean;
    requestGetProperties: (input: BrowserDiagnosticsGetPropertiesCommandInput) => boolean;
    requestReleaseObjectGroup: (input: BrowserDiagnosticsReleaseObjectGroupCommandInput) => boolean;
}>;

export type UseBrowserDiagnosticsRuntimeInput = Readonly<{
    view: BrowserControlViewState | null;
    enabled?: boolean;
    actionExecute?: (...args: Parameters<FrontDoorActionExecute>) => ReturnType<FrontDoorActionExecute>;
    actionContext?: Parameters<FrontDoorActionExecute>[2];
    isCurrent?: () => boolean;
    /** The same collector identity is needed by automation even with diagnostics hidden. */
    automationEnabled?: boolean;
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

function canAttachInjectedDiagnostics(view: BrowserControlViewState, includeWebCollector = false): boolean {
    const supportedAdapter = view.adapterKind === 'localPreview'
        || view.adapterKind === 'hostedPlugin'
        || view.adapterKind === 'externalUrl';
    // The iframe engine verifies actual document access and collector installation before admission.
    return supportedAdapter && (view.engineKind === 'nativeWebView'
        || (includeWebCollector && view.engineKind === 'webIframe'));
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
    const [eventSource] = React.useState(() => createStore<BrowserDiagnosticsUiStore>(createBrowserDiagnosticsUiStore));
    // Initial inactivity is not a revocation: an admitted diagnostic Action supplies consent.
    // Explicit Disable remains authoritative until the user enables interaction again.
    const [interactionEnabled, setInteractionEnabled] = React.useState<boolean | null>(null);
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
    const pendingResults = React.useRef(new Map<string, PendingDiagnosticsResult>());
    const unavailable = React.useMemo(() => ({ ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_diagnostics_unavailable' } as const), []);
    const actionExecute = React.useMemo(() => input.actionExecute ?? createFrontDoorActionExecute(), [input.actionExecute]);
    const viewKey = runtimeViewKey(input.view);
    // The injected engine bridge is the local owner present on this device; full console fidelity is
    // the local-owner default (plan rule #3). Agent/remote egress is redacted by the classifier SSOT.
    const valueCapture = input.enabled === true && (input.consoleValueCapture ?? true);

    const onEvents = React.useCallback<BrowserDiagnosticsEngineBridgeConfig['onEvents']>((events) => {
        if (input.enabled !== true) return;
        eventSource.setState((current) => applyBrowserDiagnosticEvents(current, {
            events,
            consoleValueCapture: valueCapture,
            valueCapture,
        }), true);
    }, [eventSource, input.enabled, valueCapture]);

    const daemonSnapshot = React.useMemo<UseBrowserDiagnosticsDaemonSnapshotInput | undefined>(() => (
        input.enabled === true && resolveBrowserDiagnosticsSnapshotMachineId(input.view)
            ? { view: input.view, enabled: true, serverId: input.daemonSnapshotServerId,
                refreshIntervalMs: input.daemonSnapshotRefreshIntervalMs,
                snapshotClient: input.daemonSnapshotClient, onEvents }
            : undefined
    ), [input.enabled, input.view, input.daemonSnapshotServerId, input.daemonSnapshotRefreshIntervalMs,
        input.daemonSnapshotClient, onEvents]);

    React.useEffect(() => {
        setInteractionEnabled(current => current === false ? false : null);
        setPickerActive(false);
        setPendingRequests({});
        // Navigation/clear: the page's remote objects belong to the prior generation's object group
        // and are gone — drop any stored console results + expanded properties so nothing leaks across
        // navigation generations.
        setEvalEntries([]);
        setObjectProperties({});
    }, [viewKey]);

    // Only document/transport identity rotates the installed collector, not title/history projection.
    const browserSessionId = input.view?.browserSessionId;
    const viewId = input.view?.viewId;
    const navigationGeneration = input.view?.navigationGeneration;
    React.useEffect(() => {
        if (browserSessionId === undefined || viewId === undefined || navigationGeneration === undefined) return;
        eventSource.setState((current) => advanceBrowserDiagnosticsGeneration(current, { browserSessionId, viewId, navigationGeneration }), true);
    }, [eventSource, browserSessionId, viewId, navigationGeneration]);
    const injected = !!input.view && canAttachInjectedDiagnostics(input.view, input.automationEnabled === true);
    const desktopInjected = !!input.view && !injected && canAttachDesktopInjectedDiagnostics(input.view);
    const requiresOriginHandshake = input.view?.engineKind === 'webIframe';
    const sourceOrigin = normalizeHttpOrigin(input.view?.securityOrigin) ?? normalizeHttpOrigin(input.view?.currentUrl);
    const parentOrigin = normalizeHttpOrigin(input.parentOrigin) ?? defaultParentOrigin();
    const bridgeBase = React.useMemo<BrowserDiagnosticsBridgeBaseConfig | null>(() => {
        if ((input.enabled !== true && input.automationEnabled !== true)
            || !browserSessionId || !viewId || navigationGeneration === undefined) {
            return null;
        }
        if (!injected && !desktopInjected) {
            return null;
        }

        if (injected && requiresOriginHandshake && (!sourceOrigin || !parentOrigin)) {
            return null;
        }

        const collectorToken = createCryptoToken();
        const nonce = createCryptoToken();
        if (!collectorToken || !nonce) {
            return null;
        }

        return {
            browserSessionId,
            viewId,
            navigationGeneration,
            collectorId: `browser_diagnostics:${viewId}:${navigationGeneration}:${collectorToken}`,
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
        input.automationEnabled,
        browserSessionId,
        viewId,
        navigationGeneration,
        injected,
        desktopInjected,
        requiresOriginHandshake,
        sourceOrigin,
        parentOrigin,
        input.view?.engineKind,
        input.view?.adapterKind,
        valueCapture,
        onEvents,
    ]);

    // Interactive diagnostics (eval / element-picker) push command scripts INTO the page. Native
    // WebView injected surfaces deliver them through their bridge; the desktop engine evals them via
    // the host `desktop_browser_eval_script` command (results return over the same ipc/drain channel).
    // Collector-enabled iframes use the engine's nonce-bound command channel. Without that
    // existing automation opt-in, keep iframe interaction unavailable rather than inventing a bridge.
    const interactionSupported = input.enabled === true
        && !!input.view
        && (canAttachInjectedDiagnostics(input.view, input.automationEnabled === true)
            || canAttachDesktopInjectedDiagnostics(input.view));

    const currentRef = React.useRef({ input, interactionEnabled, bridgeBase, interactionSupported });
    currentRef.current = { input, interactionEnabled, bridgeBase, interactionSupported };
    const settleResult = React.useCallback((requestId: string, result: unknown) => {
        const pending = pendingResults.current.get(requestId);
        if (!pending) return;
        pendingResults.current.delete(requestId);
        pending.dispose();
        pending.settle(result);
        setPendingRequests(projectPendingRequests(pendingResults.current.values()));
    }, []);
    const diagnostics = React.useMemo<BrowserRuntimeDiagnosticsAdapter>(() => ({ execute: async args => {
        const current = currentRef.current;
        const view = current.input.view;
        const request = args.input as Record<string, unknown>;
        if (!view || current.input.isCurrent?.() === false || !current.bridgeBase || !current.interactionSupported
            || (current.interactionEnabled === false && args.actionId !== 'browser.diagnostics.releaseObjectGroup')
            || request.browserSessionId !== view.browserSessionId || request.viewId !== view.viewId
            || request.navigationGeneration !== view.navigationGeneration || request.tier !== 'injectedPage'
            || args.context.signal?.aborted) return unavailable;
        const { browserSessionId: _browserSessionId, ...engineRequest } = request;
        const requestId = request.evalRequestId ?? request.propertyRequestId ?? request.releaseRequestId ?? request.pickerRequestId;
        if (typeof requestId !== 'string' || pendingResults.current.has(requestId)) return unavailable;
        let pendingRequest: BrowserDiagnosticsPendingRequests;
        switch (args.actionId) {
                case 'browser.diagnostics.eval': {
                    const evalRequest = BrowserDiagnosticsEvalRequestV1Schema.parse(engineRequest);
                    setEvalEntries(entries => {
                        const entry = { evalRequestId: evalRequest.evalRequestId, expression: evalRequest.expression,
                            objectGroupId: evalRequest.objectGroupId, status: 'pending' as const };
                        return entries.some(current => current.evalRequestId === entry.evalRequestId)
                            ? entries.map(current => current.evalRequestId === entry.evalRequestId ? entry : current)
                            : [...entries, entry];
                    });
                    pendingRequest = { evalRequest };
                    break;
                }
                case 'browser.diagnostics.getProperties':
                    pendingRequest = { getPropertiesRequest: BrowserDiagnosticsGetPropertiesRequestV1Schema.parse(engineRequest) };
                    break;
                case 'browser.diagnostics.releaseObjectGroup':
                    pendingRequest = { releaseObjectGroupRequest: BrowserDiagnosticsReleaseObjectGroupRequestV1Schema.parse(engineRequest) };
                    break;
                case 'browser.diagnostics.elementPicker.start':
                case 'browser.diagnostics.elementPicker.cancel':
                    if (args.actionId === 'browser.diagnostics.elementPicker.start') setPickerActive(true);
                    pendingRequest = { elementPickerRequest: BrowserDiagnosticsElementPickerRequestV1Schema.parse(engineRequest) };
                    break;
                default: return unavailable;
        }
        if (current.interactionEnabled === null && args.actionId !== 'browser.diagnostics.releaseObjectGroup') {
            currentRef.current.interactionEnabled = true;
            setInteractionEnabled(true);
        }
        return await new Promise(resolve => {
            const onAbort = () => settleResult(requestId, { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
            pendingResults.current.set(requestId, { request: pendingRequest, settle: resolve, dispose: () => args.context.signal?.removeEventListener('abort', onAbort) });
            args.context.signal?.addEventListener('abort', onAbort, { once: true });
            setPendingRequests(projectPendingRequests(pendingResults.current.values()));
        });
    } }), [settleResult, unavailable]);
    React.useEffect(() => () => {
        for (const requestId of pendingResults.current.keys()) settleResult(requestId, unavailable);
    }, [viewKey, settleResult, unavailable]);

    const dispatchUi = React.useCallback((actionId: Parameters<FrontDoorActionExecute>[0], request: BrowserDiagnosticsEvalRequestV1 | BrowserDiagnosticsGetPropertiesRequestV1 | BrowserDiagnosticsReleaseObjectGroupRequestV1 | BrowserDiagnosticsElementPickerRequestV1) => {
        const view = input.view;
        if (!view) return;
        const showRefusal = (errorCode: string) => {
            if (!currentRef.current.interactionEnabled || currentRef.current.input.isCurrent?.() === false
                || runtimeViewKey(currentRef.current.input.view) !== runtimeViewKey(view)) return;
            if ('evalRequestId' in request) setEvalEntries(entries => {
                const entry = { evalRequestId: request.evalRequestId, expression: request.expression,
                    objectGroupId: request.objectGroupId, status: 'blocked' as const, errorCode };
                return entries.some(current => current.evalRequestId === request.evalRequestId)
                    ? entries.map(current => current.evalRequestId === request.evalRequestId ? entry : current)
                    : [...entries, entry];
            });
            if ('propertyRequestId' in request) setObjectProperties(entries => ({ ...entries,
                [request.objectId]: { status: 'failed', properties: [], errorCode } }));
        };
        void actionExecute(actionId, { ...request, browserSessionId: view.browserSessionId }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, ...input.actionContext,
        }).then(result => {
            if (!result.ok) showRefusal(result.errorCode);
            else if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) showRefusal('approval_request_created');
        }, () => showRefusal('action_failed'));
    }, [actionExecute, input.actionContext, input.view]);

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
        dispatchUi('browser.diagnostics.eval', request);
        return true;
    }, [dispatchUi, getInteractiveView, nextRequestId]);

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
        dispatchUi('browser.diagnostics.getProperties', request);
        return true;
    }, [dispatchUi, getInteractiveView, nextRequestId]);

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
        dispatchUi('browser.diagnostics.releaseObjectGroup', request);
        return true;
    }, [dispatchUi, getInteractiveView, nextRequestId]);

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
        dispatchUi('browser.diagnostics.elementPicker.start', request);
    }, [dispatchUi, getInteractiveView, nextRequestId]);

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
        dispatchUi('browser.diagnostics.elementPicker.cancel', request);
    }, [dispatchUi, getInteractiveView, nextRequestId]);

    const handleEvalResult = React.useCallback((result: BrowserDiagnosticsEvalResultV1) => {
        if (!pendingResults.current.has(result.evalRequestId)) return;
        settleResult(result.evalRequestId, result);
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
    }, [settleResult]);

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
        if (!pendingResults.current.has(result.propertyRequestId)) return;
        settleResult(result.propertyRequestId, result);
        // DEV-4: store the expanded properties keyed by objectId so the inspector tree renders them.
        setObjectProperties((current) => ({
            ...current,
            [result.objectId]: result.status === 'completed'
                ? { status: 'loaded', properties: result.properties }
                : { status: 'failed', properties: [], ...(result.errorCode ? { errorCode: result.errorCode } : {}) },
        }));
    }, [settleResult]);

    const handleReleaseObjectGroupResult = React.useCallback((result: BrowserDiagnosticsReleaseObjectGroupResultV1) => {
        if (!pendingResults.current.has(result.releaseRequestId)) return;
        settleResult(result.releaseRequestId, result);
    }, [settleResult]);

    const onElementPickerResultBridge = input.onElementPickerResult;
    const handleElementPickerResult = React.useCallback((result: BrowserDiagnosticsElementPickerResultV1) => {
        if (!pendingResults.current.has(result.pickerRequestId)) return;
        settleResult(result.pickerRequestId, result);
        if (result.status === 'cancelled') {
            for (const [requestId, pending] of pendingResults.current) {
                if (pending.request.elementPickerRequest?.action === 'start') {
                    settleResult(requestId, { ...result, pickerRequestId: requestId });
                }
            }
        }
        if (result.status === 'selected' || result.status === 'cancelled' || result.status === 'blocked' || result.status === 'failed') {
            setPickerActive(false);
        }
        // Bridge a selected element to the host (→ annotation captureElement). Non-selected results
        // are forwarded too so the host can clear any pending picker UI; the host helper no-ops them.
        onElementPickerResultBridge?.(result);
    }, [onElementPickerResultBridge, settleResult]);

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
                unavailableReasonCode: input.view && canAttachInjectedDiagnostics(input.view, input.automationEnabled === true)
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
                    currentRef.current.interactionEnabled = true;
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
                currentRef.current.interactionEnabled = false;
                for (const requestId of pendingResults.current.keys()) settleResult(requestId, unavailable);
                if (view) {
                    requestReleaseObjectGroup({ objectGroupId: defaultObjectGroupId(view) });
                }
                setInteractionEnabled(false);
                setPickerActive(false);
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
        settleResult,
        startElementPicker,
        unavailable,
    ]);

    const hasDaemonSnapshotSource = daemonSnapshot !== undefined;
    const readAvailability = React.useCallback(() => hasDaemonSnapshotSource || !!bridge || !!(browserSessionId && viewId
        && selectBrowserDiagnosticsEventCount(eventSource.getState(), { browserSessionId, viewId })),
    [hasDaemonSnapshotSource, bridge, browserSessionId, eventSource, viewId]);
    const hasRenderableDiagnostics = React.useSyncExternalStore(eventSource.subscribe, readAvailability, readAvailability);
    return React.useMemo(() => {
        if ((input.enabled !== true && input.automationEnabled !== true) || !input.view) return null;
        return {
            get state() { return eventSource.getState(); },
            eventSource,
            hasRenderableDiagnostics,
            daemonSnapshot,
            bridge,
            interaction,
            ...(bridgeBase && interactionSupported ? { runtimeAdapter: diagnostics } : {}),
            requestEval,
            requestGetProperties,
            requestReleaseObjectGroup,
        };
    }, [input.enabled, input.automationEnabled, input.view, eventSource, hasRenderableDiagnostics, daemonSnapshot, bridge, interaction,
        requestEval, requestGetProperties, requestReleaseObjectGroup, bridgeBase, interactionSupported, diagnostics]);
}
