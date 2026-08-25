import * as React from 'react';
import type { BrowserContextCapabilities, RuntimeActionExecute } from '@happier-dev/protocol';

import type {
    AnnotationEditorMark,
    AnnotationEditorSelectCapability,
} from './AnnotationEditorOverlay';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import {
    attachActiveBrowserPageReference,
    countBrowserAnnotationDraftMarks,
    createBrowserContextAnnotationAdapter,
    createDesktopBrowserAnnotationCaptureProvider,
    markBrowserContextViewNavigation,
    readBrowserAnnotationDraft,
    registerBrowserContextAnnotationAdapter,
    resolveBrowserAnnotationRuntimeActionIdForRequest,
    resolveBrowserAnnotationCaptureCapability,
    type BrowserAnnotationAdapterRequest,
    type BrowserAnnotationAdapterResult,
    type BrowserAnnotationCaptureCapability,
    type BrowserAnnotationCaptureProvider,
    type BrowserAnnotationDraftInput,
    type BrowserContextState,
    type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * The browser-context / annotation half of the shell.
 *
 * This is one responsibility with a lot of surface: a capture provider chosen from the active
 * engine's capabilities, a dispatch path that prefers the runtime-action front door and falls back
 * to a local adapter, the draft→marks projection the overlay renders, and the disabled-with-reason
 * copy every affordance needs. It lived inline in `BrowserShell` and was the single largest reason
 * that file could not be read in one sitting. Nothing here is new — the owners it calls
 * (`sync/domains/browser/context`) are unchanged; only the seam moved.
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
        case 'captureRegion':
            return {
                ...base,
                ...(request.target ? { target: request.target } : {}),
                ...(request.comment ? { comment: request.comment } : {}),
                ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
                ...(request.stroke ? { stroke: request.stroke } : {}),
            };
        case 'captureElement':
            return {
                ...base,
                target: request.target,
                ...(request.comment ? { comment: request.comment } : {}),
                ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
                ...(request.stroke ? { stroke: request.stroke } : {}),
            };
        case 'attachComment':
            return {
                ...base,
                contextId: request.contextId,
                comment: request.comment,
            };
        case 'attachStroke':
            return {
                ...base,
                contextId: request.contextId,
                stroke: request.stroke,
            };
        case 'attachStyleIntent':
            return {
                ...base,
                contextId: request.contextId,
                styleIntent: request.styleIntent,
            };
        default:
            return base;
    }
}

export type BrowserShellContextState = Readonly<{
    state: BrowserContextState;
    contextCapabilities: BrowserContextCapabilities;
    enabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    browserDiagnosticsEnabled?: boolean;
    disabledReason?: string | null;
    annotationDraft?: BrowserAnnotationDraftInput | null;
    annotationCaptureProvider?: BrowserAnnotationCaptureProvider | null;
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
    /**
     * ANNO-1 Select tool: the app-layer overlay intercepts pointer events so it cannot hit-test the
     * page DOM directly. The host wires this to the element-picker owner, which resolves a picked
     * element and dispatches `addDraftTarget` through the same annotation adapter. Absent ⇒ Select is
     * an inert affordance (no fabricated element target).
     */
    onAnnotationSelectElement?: () => void;
}>;

export type BrowserAnnotationController = Readonly<{
    /** True while the in-page editor overlay should be mounted for the live view. */
    editorActive: boolean;
    captureCapability: BrowserAnnotationCaptureCapability;
    selectCapability: AnnotationEditorSelectCapability;
    marks: readonly AnnotationEditorMark[];
    markCount: number;
    commentValue: string;
    /** Attach the current page as a context reference. */
    attachPageReference: () => void;
    start: () => void;
    cancel: () => void;
    capture: () => Promise<void>;
    addRegion: (rect: Readonly<{ x: number; y: number; width: number; height: number }>) => void;
    addStroke: (points: readonly Readonly<{ x: number; y: number }>[]) => void;
    removeMark: (draftId: string) => void;
    changeComment: (comment: string) => void;
    attachDraft: () => void;
    selectElement: () => void;
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

    const browserContextRef = React.useRef(browserContext);
    browserContextRef.current = browserContext;

    const attachPageReference = React.useCallback(() => {
        const context = browserContextRef.current;
        if (!context) return;

        const result = attachActiveBrowserPageReference({
            state: context.state,
            browserContextEnabled: context.enabled !== false,
            contextCapabilities: context.contextCapabilities,
            view: activeView,
            capturedAtMs: context.nowMs?.() ?? Date.now(),
        });

        if (result.status === 'attached') {
            context.onStateChange(result.state);
            return;
        }

        context.onAttachUnavailable?.(result.reason);
    }, [activeView]);

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
                state: context?.state ?? ({} as BrowserContextState),
                view: activeViewRef.current,
                browserContextEnabled: context?.enabled !== false,
                browserDiagnosticsEnabled: context?.browserDiagnosticsEnabled,
                attachmentsUploadsEnabled: context?.attachmentsUploadsEnabled,
                contextCapabilities: context?.contextCapabilities ?? ({} as BrowserContextCapabilities),
                captureProvider: effectiveCaptureProviderRef.current,
                annotationDraft: context?.annotationDraft,
                nowMs: context?.nowMs,
            };
        },
        onStateChange: (state) => {
            browserContextRef.current?.onStateChange(state);
        },
    }), []);

    // Register the adapter so the runtime-action front door (and thus an agent) can drive annotation
    // for the active session/view. Keyed on the live view so a stale host can't service another view.
    React.useEffect(() => {
        if (!browserContext || !activeView) return undefined;
        return registerBrowserContextAnnotationAdapter({
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            adapter: annotationAdapter,
        });
    }, [annotationAdapter, activeView, browserContext]);

    const dispatchAnnotation = React.useCallback(async (
        request: BrowserAnnotationAdapterRequest,
    ): Promise<void> => {
        const context = browserContextRef.current;
        if (!context) return;
        const actionId = resolveBrowserAnnotationRuntimeActionIdForRequest(request);
        if (actionId && context.annotationRuntimeActionExecute && activeViewRef.current) {
            const result = await context.annotationRuntimeActionExecute({
                actionId,
                input: buildAnnotationRuntimeActionInput(activeViewRef.current, request),
                context: {
                    surface: 'ui',
                    placement: 'browser_context',
                },
            });
            if (isRuntimeActionFailureResult(result)) {
                context.onAttachUnavailable?.({
                    reasonCode: 'browser_context_annotation_capture_unavailable',
                    lifecycleState: 'adapterUnavailable',
                    message: result.error ?? result.errorCode ?? 'browser_context_annotation_unavailable',
                });
            }
            return;
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
    }, [annotationAdapter]);

    const start = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'start' });
    }, [dispatchAnnotation]);

    const cancel = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'cancel' });
    }, [dispatchAnnotation]);

    const capture = React.useCallback(async () => {
        const context = browserContextRef.current;
        if (!context) return;
        // The toolbar capture button captures a full-page region annotation. When a caller-supplied
        // draft target exists it is honored; otherwise the capture provider produces the region.
        const draftTarget = context.annotationDraft?.target;
        if (draftTarget?.kind === 'element') {
            await dispatchAnnotation({
                kind: 'captureElement',
                target: draftTarget,
                ...(context.annotationDraft?.comment ? { comment: context.annotationDraft.comment } : {}),
                ...(context.annotationDraft?.styleIntent ? { styleIntent: context.annotationDraft.styleIntent } : {}),
                ...(context.annotationDraft?.stroke ? { stroke: context.annotationDraft.stroke } : {}),
            });
            return;
        }
        await dispatchAnnotation({
            kind: 'captureRegion',
            // Omit target → the capture provider produces the full-page region snapshot. A marquee
            // region draft (if present) overrides it.
            ...(draftTarget?.kind === 'region' ? { target: draftTarget } : {}),
            ...(context.annotationDraft?.comment ? { comment: context.annotationDraft.comment } : {}),
            ...(context.annotationDraft?.styleIntent ? { styleIntent: context.annotationDraft.styleIntent } : {}),
            ...(context.annotationDraft?.stroke ? { stroke: context.annotationDraft.stroke } : {}),
        });
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

        const nextState = markBrowserContextViewNavigation(browserContext.state, {
            viewId: activeView.viewId,
            navigationGeneration: activeView.navigationGeneration,
        });
        if (nextState === browserContext.state) return;

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
    const draftAvailable = Boolean(browserContext?.annotationDraft)
        || effectiveCaptureProvider?.available === true;

    // ANNO-1 in-page editor view model. The overlay is the visual authoring surface; it dispatches
    // the same DRAFT actions the adapter owns (no parallel reducer). It mounts only while annotation
    // mode is active for the live view. Capture availability comes from the ANNO-6 engine-matrix
    // capability owner so the overlay surfaces a disabled-with-reason state on engines with no
    // cropped-capture producer (iframe / RN), never silently hiding.
    const editorActive = supported && active && Boolean(activeView);
    const captureCapability = React.useMemo<BrowserAnnotationCaptureCapability>(() => {
        if (!activeView) {
            return { available: false, disabledReason: 'browser_context_annotation_capture_unavailable' };
        }
        return resolveBrowserAnnotationCaptureCapability({
            adapterKind: activeView.adapterKind,
            primaryEngine: activeView.engineKind,
            desktopCaptureSupported,
            managedCaptureGateEnabled: browserContext?.managedAnnotationCaptureProvider === true
                && effectiveCaptureProvider?.available === true,
        });
    }, [
        activeView,
        desktopCaptureSupported,
        effectiveCaptureProvider?.available,
        browserContext?.managedAnnotationCaptureProvider,
    ]);
    const captureProducerUnavailable = captureCapability.available === false
        && effectiveCaptureProvider?.available !== true;
    const contextDisabledReason = React.useMemo(() => {
        const disabledReason = browserContext?.disabledReason;
        if (typeof disabledReason === 'string' && disabledReason.length > 0) {
            return resolveReasonCopy({ reasonCode: disabledReason, kind: 'browserFrame' }).message;
        }
        return !activeView
            ? resolveReasonCopy({ reasonCode: 'target_kind_unavailable', kind: 'browserFrame' }).message
            : null;
    }, [activeView, browserContext?.disabledReason]);
    const captureDisabledReason = captureCapability.available === false
        ? resolveReasonCopy({ reasonCode: captureCapability.disabledReason, kind: 'browserFrame' }).message
        : null;
    // Memoized on the boolean, not rebuilt per render: this object is a memo dependency upstream,
    // so a fresh literal would invalidate the controller bundle on every render.
    const selectElementSupported = Boolean(browserContext?.onAnnotationSelectElement);
    const selectCapability = React.useMemo<AnnotationEditorSelectCapability>(
        () => (selectElementSupported
            ? { available: true }
            : { available: false, disabledReason: 'browser_context_annotation_picker_unavailable' }),
        [selectElementSupported],
    );
    const annotationDraft = activeView && browserContext
        ? readBrowserAnnotationDraft(browserContext.state, activeView.viewId)
        : null;
    const markCount = activeView && browserContext
        ? countBrowserAnnotationDraftMarks(browserContext.state, activeView.viewId)
        : 0;
    const marks = React.useMemo<readonly AnnotationEditorMark[]>(() => {
        if (!annotationDraft) return [];
        return [
            ...annotationDraft.targets.map((target) => ({
                draftId: target.draftId,
                kind: 'element' as const,
                label: t('browserContext.editor.markElement', { label: target.accessibleName ?? target.selectorPath }),
                rect: target.rect,
            })),
            ...annotationDraft.regions.map((region) => ({
                draftId: region.draftId,
                kind: 'region' as const,
                label: t('browserContext.editor.markRegion'),
                rect: region.rect,
            })),
            ...annotationDraft.strokes.map((stroke) => ({
                draftId: stroke.draftId,
                kind: 'stroke' as const,
                label: t('browserContext.editor.markStroke'),
                points: stroke.points,
            })),
        ];
    }, [annotationDraft]);

    const addRegion = React.useCallback((rect: Readonly<{ x: number; y: number; width: number; height: number }>) => {
        void dispatchAnnotation({ kind: 'addDraftRegion', rect });
    }, [dispatchAnnotation]);
    const addStroke = React.useCallback((points: readonly Readonly<{ x: number; y: number }>[]) => {
        void dispatchAnnotation({ kind: 'addDraftStroke', stroke: { shape: 'freehand', points } });
    }, [dispatchAnnotation]);
    const removeMark = React.useCallback((draftId: string) => {
        void dispatchAnnotation({ kind: 'removeDraftTarget', draftId });
    }, [dispatchAnnotation]);
    const changeComment = React.useCallback((comment: string) => {
        void dispatchAnnotation({ kind: 'setDraftComment', comment });
    }, [dispatchAnnotation]);
    const attachDraft = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'attachDraft' });
    }, [dispatchAnnotation]);
    const selectElement = React.useCallback(() => {
        browserContextRef.current?.onAnnotationSelectElement?.();
    }, []);

    // Memoized: consumers take the controller as ONE value (the overflow-menu memo depends on
    // `annotation`, not on twenty fields), so a fresh literal per render would defeat every memo
    // downstream. The members are already individually stable — callbacks through `useCallback`,
    // projections through `useMemo` — so this only bundles them.
    return React.useMemo(() => ({
        editorActive,
        captureCapability,
        selectCapability,
        marks,
        markCount,
        commentValue: annotationDraft?.comment ?? '',
        attachPageReference,
        start,
        cancel,
        capture,
        addRegion,
        addStroke,
        removeMark,
        changeComment,
        attachDraft,
        selectElement,
        supported,
        active,
        contextButtonDisabled,
        contextDisabledReason,
        captureDisabledReason,
        draftAvailable,
        captureProducerUnavailable,
    }), [
        active,
        addRegion,
        addStroke,
        annotationDraft?.comment,
        attachDraft,
        attachPageReference,
        cancel,
        capture,
        captureCapability,
        captureDisabledReason,
        captureProducerUnavailable,
        changeComment,
        contextButtonDisabled,
        contextDisabledReason,
        draftAvailable,
        editorActive,
        markCount,
        marks,
        removeMark,
        selectCapability,
        selectElement,
        start,
        supported,
    ]);
}
