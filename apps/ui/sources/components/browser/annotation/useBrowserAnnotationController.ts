import * as React from 'react';
import type { BrowserContextCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type { BrowserEventV1} from '@happier-dev/protocol/browser/events/v1';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BrowserDaemonControlCommandSender } from '@/sync/domains/browser/control/machineRpc';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import {
    createBrowserContextAnnotationAdapter,
    createBrowserContextState,
    createDesktopBrowserAnnotationCaptureProvider,
    markBrowserContextViewNavigation,
    registerBrowserContextAnnotationAdapter,
    resolveBrowserAnnotationRuntimeActionIdForRequest,
    resolveBrowserAnnotationCaptureCapability,
    type BrowserAnnotationAdapterRequest,
    type BrowserAnnotationAdapterResult,
    type BrowserAnnotationCaptureCapability,
    type BrowserAnnotationCaptureProvider,
    type BrowserContextState,
    type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import type { BrowserAnnotationCommitInput, BrowserAnnotationCommitResult } from '@/components/sessions/browser/commitBrowserAnnotation';
import type { ImageMarksDocumentV1, ImagePointV1 } from '@happier-dev/protocol';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import { readFrozenBrowserAnnotationDraft, recordBrowserAnnotationElement, updateBrowserAnnotationDocument } from '@/sync/domains/browser/context/annotationDraft';
import type { BrowserFrozenAnnotationDraft } from '@/sync/domains/browser/context/types';
import type { BrowserAnnotationPickedElement } from '@/sync/domains/browser/context/elementPickerAnnotationBridge';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * The browser-context / annotation half of the shell.
 *
 * This is one responsibility with a lot of surface: a capture provider chosen from the active
 * engine's capabilities, scoped Action dispatch, and the frozen document consumed by the shared
 * canvas. The registered adapter owns capture/commit; the controller only projects that draft and
 * publishes canvas gestures together with their browser element facts.
 */

type RuntimeActionFailureResult = Readonly<{
    ok: false;
    errorCode?: string;
    error?: string;
}>;

function isRuntimeActionFailureResult(value: unknown): value is RuntimeActionFailureResult {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && 'ok' in value
        && (value as Readonly<{ ok?: unknown }>).ok === false,
    );
}

function buildAnnotationRuntimeActionInput(
    view: BrowserControlViewState,
    request: BrowserAnnotationAdapterRequest,
): unknown {
    const base = {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
    };
    switch (request.kind) {
        case 'start':
        case 'cancel':
            return base;
        case 'attachDraft':
            return { ...base, navigationGeneration: view.navigationGeneration };
        case 'setDraftComment': {
            const { kind: _kind, ...operands } = request;
            return { ...base, navigationGeneration: view.navigationGeneration, ...operands };
        }
        case 'attachPageReference':
            return { ...base, navigationGeneration: view.navigationGeneration, source: 'activePage' };
        default:
            return base;
    }
}

export type BrowserShellContextState = Readonly<{
    /** Exact owning Session Account; retained browser views never inherit the active Account. */
    accountScope?: ServerAccountScope | null;
    /** Session machine transport; controller state remains owned by the daemon. */
    daemonControl?: Readonly<{
        sendCommand: BrowserDaemonControlCommandSender;
        subscribeBrowserEvents?: (listener: (event: BrowserEventV1) => void) => () => void;
        receiveBrowserEvent?: (event: BrowserEventV1) => void;
    }>;
    state: BrowserContextState;
    /** Canonical Session state before React has published its next render projection. */
    readState?: () => BrowserContextState;
    contextCapabilities: BrowserContextCapabilities;
    enabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    browserDiagnosticsEnabled?: boolean;
    disabledReason?: string | null;
    annotationCaptureProvider?: BrowserAnnotationCaptureProvider | null;
    commitAnnotation?: (input: BrowserAnnotationCommitInput) => Promise<BrowserAnnotationCommitResult>;
    queryElementAtPoint?: (point: ImagePointV1, navigationGeneration?: number) => Promise<BrowserDiagnosticsElementPickerResultV1 | null>;
    /** True when `annotationCaptureProvider` is the daemon managed-Chromium CDP producer. */
    managedAnnotationCaptureProvider?: boolean;
    /**
     * Front-door dispatcher for the `browser.context.annotation.*` actions. When the host supplies
     * it (wired to `ActionExecutor.execute`), the toolbar handlers dispatch through it so the
     * user-initiated path shares the exact runtime-action front door an agent uses (enablement +
     * approval gates applied uniformly). When omitted, BrowserShell dispatches through a local
     * adapter built from the live binding (standalone/test path) — same canonical reducer owner.
     */
    annotationRuntimeActionExecute?: RuntimeActionExecute;
    /**
     * Legacy/test seam for callers that already own annotation dispatch. Product session hosts
     * should supply `annotationRuntimeActionExecute`; this seam remains a narrow fallback for
     * standalone BrowserShell tests and non-session embeddings.
     */
    dispatchAnnotationAction?: (
        request: BrowserAnnotationAdapterRequest,
    ) => Promise<BrowserAnnotationAdapterResult> | BrowserAnnotationAdapterResult;
    nowMs?: () => number;
    onStateChange: (state: BrowserContextState) => void;
    onAttachPageReferenceChange?: (handler: (() => void) | null) => void;
    onAttachUnavailable?: (reason: BrowserContextUnavailableReason) => void;
}>;

export type BrowserAnnotationController = Readonly<{
    draft: BrowserFrozenAnnotationDraft | null;
    capturePending: boolean;
    changeDocument: (document: ImageMarksDocumentV1) => void;
    recordElement: (markId: string, element: BrowserAnnotationPickedElement) => void;
    queryElementAtPoint: ((point: ImagePointV1) => Promise<BrowserDiagnosticsElementPickerResultV1 | null>) | null;
    /** True while annotation mode is active for the live view. */
    editorActive: boolean;
    captureCapability: BrowserAnnotationCaptureCapability;
    commentValue: string;
    /** Attach the current page as a context reference. */
    attachPageReference: () => void;
    start: () => void;
    cancel: () => void;
    changeComment: (comment: string) => Promise<Readonly<{ ok: boolean }>>;
    attachDraft: () => Promise<Readonly<{ ok: boolean }>>;
    /** Overflow-menu inputs: whether each affordance is offered, and why it is not. */
    supported: boolean;
    active: boolean;
    contextButtonDisabled: boolean;
    contextDisabledReason: string | null;
    captureDisabledReason: string | null;
    draftAvailable: boolean;
    captureProducerUnavailable: boolean;
}>;

export function useBrowserAnnotationController(input: Readonly<{
    browserContext?: BrowserShellContextState | null;
    activeView: BrowserControlViewState | null;
    /** `viewId:navigationGeneration` — the identity a context navigation mark is keyed on. */
    activeViewNavigationKey: string;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>): BrowserAnnotationController {
    const { activeView, activeViewNavigationKey, browserContext } = input;
    const [capturePending, setCapturePending] = React.useState(false);

    const browserContextRef = React.useRef(browserContext);
    browserContextRef.current = browserContext;
    // A pick resolves its facts before the canvas commits its mark. Publish them together, like
    // pointer samples at gesture end; the shared draft remains the only committed document owner.
    const pickedElementRef = React.useRef<Readonly<{
        annotationId: string; viewId: string; markId: string; element: BrowserAnnotationPickedElement;
    }> | null>(null);

    // The in-app annotation capture provider. Prefer an explicitly-supplied provider; otherwise use
    // the desktop (Wry) native-snapshot producer when the active desktop engine advertises capture
    // support. iframe/RN engines have no first-party screenshot producer yet (12.20B) → no provider
    // → the capture button stays disabled (honest fail-closed).
    const desktopCaptureSupported = Boolean(
        activeView
        && activeView.engineKind === 'desktopWebView'
        && input.desktopWebViewAvailability?.available
        && input.desktopWebViewAvailability.supports.capture,
    );
    const desktopCaptureProvider = React.useMemo<BrowserAnnotationCaptureProvider | null>(() => {
        if (!desktopCaptureSupported) return null;
        return createDesktopBrowserAnnotationCaptureProvider({ available: true });
    }, [desktopCaptureSupported]);
    const suppliedCaptureProvider = browserContext?.annotationCaptureProvider ?? null;
    const effectiveCaptureProvider = browserContext?.managedAnnotationCaptureProvider === true
        ? (activeView?.adapterKind === 'chromiumSidecar' ? suppliedCaptureProvider : desktopCaptureProvider)
        : suppliedCaptureProvider ?? desktopCaptureProvider;

    // Single canonical annotation owner. The local adapter reads the live binding (state + view +
    // capabilities + capture provider) on each dispatch and commits via `onStateChange`; it is the
    // SAME adapter shape registered for the front door so an agent and the toolbar share one path.
    const activeViewRef = React.useRef(activeView);
    activeViewRef.current = activeView;
    const effectiveCaptureProviderRef = React.useRef(effectiveCaptureProvider);
    effectiveCaptureProviderRef.current = effectiveCaptureProvider;

    const annotationAdapter = React.useMemo(() => createBrowserContextAnnotationAdapter({
        resolveBinding: () => {
            const context = browserContextRef.current;
            return {
                state: context?.readState?.() ?? context?.state ?? createBrowserContextState(),
                view: context ? activeViewRef.current : null,
                browserContextEnabled: Boolean(context) && context?.enabled !== false,
                browserDiagnosticsEnabled: context?.browserDiagnosticsEnabled,
                attachmentsUploadsEnabled: context?.attachmentsUploadsEnabled,
                contextCapabilities: context?.contextCapabilities ?? ({} as BrowserContextCapabilities),
                captureProvider: effectiveCaptureProviderRef.current,
                commitAnnotation: context?.commitAnnotation,
                nowMs: context?.nowMs,
            };
        },
        onStateChange: (state) => {
            browserContextRef.current?.onStateChange(state);
        },
    }), []);

    // Register the adapter so the runtime-action front door (and thus an agent) can drive annotation
    // for the active session/view. Keyed on the live view so a stale host can't service another view.
    const annotationBrowserSessionId = activeView?.browserSessionId;
    const annotationViewId = activeView?.viewId;
    const annotationServerId = browserContext?.accountScope?.serverId;
    const annotationAccountId = browserContext?.accountScope?.accountId;
    React.useEffect(() => {
        if (!annotationBrowserSessionId || !annotationViewId || !annotationServerId || !annotationAccountId) return undefined;
        return registerBrowserContextAnnotationAdapter({
            browserSessionId: annotationBrowserSessionId,
            viewId: annotationViewId,
            scope: { serverId: annotationServerId, accountId: annotationAccountId },
            adapter: annotationAdapter,
        });
    }, [annotationAdapter, annotationBrowserSessionId, annotationViewId, annotationServerId, annotationAccountId]);

    const dispatchAnnotation = React.useCallback(async (
        request: BrowserAnnotationAdapterRequest,
    ): Promise<Readonly<{ ok: boolean }>> => {
        const context = browserContextRef.current;
        if (!context) return { ok: false };
        const actionId = resolveBrowserAnnotationRuntimeActionIdForRequest(request);
        if (actionId && context.annotationRuntimeActionExecute && activeViewRef.current) {
            const result = await context.annotationRuntimeActionExecute({
                actionId,
                input: buildAnnotationRuntimeActionInput(activeViewRef.current, request),
                context: {
                    surface: 'ui',
                    placement: 'browser_context',
                    serverId: context.accountScope?.serverId,
                    expectedAccountId: context.accountScope?.accountId,
                    actionCaller: { kind: 'host' },
                    authority: 'present_user',
                },
            });
            if (isRuntimeActionFailureResult(result)) {
                context.onAttachUnavailable?.({
                    reasonCode: 'browser_context_annotation_capture_unavailable',
                    lifecycleState: 'adapterUnavailable',
                    message: result.error ?? result.errorCode ?? 'browser_context_annotation_unavailable',
                });
            }
            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result).success;
            const committed = request.kind !== 'attachDraft'
                || (typeof result === 'object' && result !== null && 'status' in result && result.status === 'committed');
            return { ok: !isRuntimeActionFailureResult(result) && !pending && committed };
        }
        const dispatcher = context.dispatchAnnotationAction ?? annotationAdapter.dispatch;
        const result = await dispatcher(request);
        if (result.status === 'unavailable') {
            const reason = typeof result.reason === 'string'
                ? {
                    reasonCode: 'browser_context_annotation_capture_unavailable' as const,
                    lifecycleState: 'adapterUnavailable' as const,
                    message: result.reason,
                }
                : result.reason;
            context.onAttachUnavailable?.(reason);
        }
        return { ok: result.status !== 'unavailable' };
    }, [annotationAdapter]);

    const attachPageReference = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'attachPageReference' });
    }, [dispatchAnnotation]);

    const start = React.useCallback(() => {
        setCapturePending(true);
        void dispatchAnnotation({ kind: 'start' }).finally(() => setCapturePending(false));
    }, [dispatchAnnotation]);

    const cancel = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'cancel' });
    }, [dispatchAnnotation]);

    const onAttachPageReferenceChange = browserContext?.onAttachPageReferenceChange;
    React.useEffect(() => {
        if (!onAttachPageReferenceChange) return undefined;
        onAttachPageReferenceChange(activeView ? attachPageReference : null);
        return () => {
            onAttachPageReferenceChange(null);
        };
    }, [activeView, attachPageReference, onAttachPageReferenceChange]);

    React.useEffect(() => {
        if (!browserContext || !activeView) return;

        const current = browserContext.readState?.() ?? browserContext.state;
        const nextState = markBrowserContextViewNavigation(current, {
            viewId: activeView.viewId,
            navigationGeneration: activeView.navigationGeneration,
        });
        if (nextState === current) return;

        browserContext.onStateChange(nextState);
        // `activeViewNavigationKey` is the navigation identity; re-running on every context object
        // identity would re-mark the same navigation on each render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [browserContext, activeViewNavigationKey]);

    const contextButtonDisabled = !activeView || Boolean(browserContext?.disabledReason);
    const active = Boolean(
        activeView && browserContext?.state.activeAnnotationByViewId?.[activeView.viewId],
    );
    const supported = browserContext?.contextCapabilities.supportedContextKinds.includes('browserAnnotation') === true;
    const draftAvailable = effectiveCaptureProvider?.available === true;

    // The shared canvas edits the one frozen document owned by the registered adapter.
    const editorActive = supported && active && Boolean(activeView);
    const captureCapability = React.useMemo<BrowserAnnotationCaptureCapability>(() => {
        if (!activeView) {
            return { available: false, disabledReason: 'browser_context_annotation_capture_unavailable' };
        }
        return resolveBrowserAnnotationCaptureCapability({
            adapterKind: activeView.adapterKind,
            primaryEngine: activeView.engineKind,
            captureSourceAvailable: draftAvailable,
        });
    }, [
        activeView,
        draftAvailable,
    ]);
    const captureProducerUnavailable = captureCapability.available === false;
    const contextDisabledReason = React.useMemo(() => {
        const disabledReason = browserContext?.disabledReason;
        return typeof disabledReason === 'string' && disabledReason.length > 0
            ? resolveReasonCopy({ reasonCode: disabledReason, kind: 'browserFrame' }).message
            : null;
    }, [browserContext?.disabledReason]);
    const captureDisabledReason = captureCapability.available === false
        ? resolveReasonCopy({ reasonCode: captureCapability.disabledReason, kind: 'browserFrame' }).message
        : null;
    const draft = activeView && browserContext
        ? readFrozenBrowserAnnotationDraft(browserContext.state, activeView.viewId) : null;
    const changeComment = React.useCallback((comment: string) => dispatchAnnotation({ kind: 'setDraftComment', comment }), [dispatchAnnotation]);
    const attachDraft = React.useCallback(() => dispatchAnnotation({ kind: 'attachDraft' }), [dispatchAnnotation]);
    const changeDocument = React.useCallback((document: ImageMarksDocumentV1) => {
        const context = browserContextRef.current;
        const view = activeViewRef.current;
        if (!context || !view) return;
        const state = context.readState?.() ?? context.state;
        const picked = pickedElementRef.current;
        const draft = readFrozenBrowserAnnotationDraft(state, view.viewId);
        const withFacts = picked?.viewId === view.viewId && picked.annotationId === draft?.annotationId
            ? recordBrowserAnnotationElement(state, picked) : state;
        pickedElementRef.current = null;
        const next = updateBrowserAnnotationDocument(withFacts, { viewId: view.viewId, document });
        if (next !== state) context.onStateChange(next);
    }, []);
    const recordElement = React.useCallback((markId: string, element: BrowserAnnotationPickedElement) => {
        const context = browserContextRef.current;
        const view = activeViewRef.current;
        if (!context || !view) return;
        const state = context.readState?.() ?? context.state;
        const draft = readFrozenBrowserAnnotationDraft(state, view.viewId);
        if (draft) pickedElementRef.current = { annotationId: draft.annotationId, viewId: view.viewId, markId, element };
    }, []);
    const queryFrozenElement = React.useCallback((point: ImagePointV1) => {
        const context = browserContextRef.current;
        const view = activeViewRef.current;
        if (!context?.queryElementAtPoint || !view) return Promise.resolve(null);
        const draft = readFrozenBrowserAnnotationDraft(context.readState?.() ?? context.state, view.viewId);
        if (!draft) return Promise.resolve(null);
        // The diagnostics owner rejects a stale generation; never hit-test a new page for an old still.
        return context.queryElementAtPoint(point, draft.navigationGeneration);
    }, []);
    const queryElementAtPoint = browserContext?.queryElementAtPoint ? queryFrozenElement : null;

    // Memoized: consumers take the controller as ONE value (the overflow-menu memo depends on
    // `annotation`, not on twenty fields), so a fresh literal per render would defeat every memo
    // downstream. The members are already individually stable — callbacks through `useCallback`,
    // projections through `useMemo` — so this only bundles them.
    return React.useMemo(() => ({
        draft,
        capturePending,
        changeDocument,
        recordElement,
        queryElementAtPoint,
        editorActive,
        captureCapability,
        commentValue: draft?.comment ?? '',
        attachPageReference,
        start,
        cancel,
        changeComment,
        attachDraft,
        supported,
        active,
        contextButtonDisabled,
        contextDisabledReason,
        captureDisabledReason,
        draftAvailable,
        captureProducerUnavailable,
    }), [
        draft,
        capturePending,
        changeDocument,
        recordElement,
        queryElementAtPoint,
        active,
        attachDraft,
        attachPageReference,
        cancel,
        captureCapability,
        captureDisabledReason,
        captureProducerUnavailable,
        changeComment,
        contextButtonDisabled,
        contextDisabledReason,
        draftAvailable,
        editorActive,
        start,
        supported,
    ]);
}
