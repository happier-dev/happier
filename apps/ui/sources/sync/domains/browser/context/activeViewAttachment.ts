import type { BrowserContextCapabilities } from '@happier-dev/protocol';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import {
    captureBrowserAnnotation,
    captureBrowserPageReference,
    cancelBrowserAnnotationMode,
    startBrowserAnnotationMode,
    resolveBrowserContextKindAvailability,
} from './actions';
import { attachBrowserContextToComposer } from './state';
import type {
    BrowserAnnotationDraftInput,
    BrowserAnnotationEditorDraft,
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationCaptureProviderResult,
    BrowserAnnotationModeResult,
    BrowserContextAttachResult,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

export type ActiveBrowserAnnotationBinding = Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
}>;

/** One live admission owner for single captures and grouped draft captures. */
export function createActiveBrowserAnnotationCaptureAdmission(params: Readonly<{
    binding: ActiveBrowserAnnotationBinding;
    resolveBinding: () => ActiveBrowserAnnotationBinding;
    draft?: BrowserAnnotationEditorDraft;
}>): () => BrowserContextUnavailableReason | null {
    const originalView = params.binding.view;
    const originalMode = originalView ? params.binding.state.activeAnnotationByViewId[originalView.viewId] : undefined;
    return () => {
        const current = params.resolveBinding();
        const view = current.view;
        if (!view || !originalView) {
            return createUnavailableReason('browser_context_view_unavailable', 'adapterUnavailable', 'No active browser view is available to annotate.');
        }
        if (view.browserSessionId !== originalView.browserSessionId || view.viewId !== originalView.viewId
            || view.navigationGeneration !== originalView.navigationGeneration
            || (current.state.navigationGenerationByViewId[view.viewId] ?? view.navigationGeneration) !== view.navigationGeneration) {
            return createAnnotationStaleReason();
        }
        const policyDenial = resolveBrowserContextKindAvailability({
            ...current,
            kind: 'browserAnnotation',
            adapterCapabilities: view.adapterCapabilities,
        });
        if (policyDenial) return policyDenial;
        const activeDenial = resolveActiveAnnotationBindingUnavailable({ state: current.state, view });
        if (activeDenial) return activeDenial;
        if (current.state.activeAnnotationByViewId[view.viewId] !== originalMode) return createAnnotationStaleReason();
        if (params.draft) {
            const draft = current.state.annotationDraftByViewId[view.viewId];
            if (!draft || draft.annotationId !== params.draft.annotationId
                || draft.browserSessionId !== view.browserSessionId || draft.navigationGeneration !== view.navigationGeneration
                || draft.targets !== params.draft.targets || draft.regions !== params.draft.regions || draft.strokes !== params.draft.strokes) {
                return createAnnotationStaleReason();
            }
        }
        return null;
    };
}

function createUnavailableReason(
    reasonCode: BrowserContextUnavailableReason['reasonCode'],
    lifecycleState: BrowserContextUnavailableReason['lifecycleState'],
    message: string,
): BrowserContextUnavailableReason {
    return { reasonCode, lifecycleState, message };
}

function buildAttachmentId(contextId: string): string {
    return `browser_context_attachment:${contextId}`;
}

function createAnnotationCaptureUnavailableReason(): BrowserContextUnavailableReason {
    return createUnavailableReason(
        'browser_context_annotation_capture_unavailable',
        'adapterUnavailable',
        'Browser annotation capture is unavailable for this view.',
    );
}

function createAnnotationCaptureFailedReason(): BrowserContextUnavailableReason {
    return createUnavailableReason(
        'browser_context_annotation_capture_failed',
        'captureFailed',
        'Browser annotation capture failed.',
    );
}

function createAnnotationStaleReason(): BrowserContextUnavailableReason {
    return createUnavailableReason(
        'browser_context_annotation_stale',
        'navigationStale',
        'Browser annotation capture no longer matches the current page.',
    );
}

function resolveActiveAnnotationBindingUnavailable(params: Readonly<{
    state: BrowserContextState;
    view: BrowserControlViewState;
}>): BrowserContextUnavailableReason | null {
    const active = params.state.activeAnnotationByViewId[params.view.viewId];
    if (!active || active.browserSessionId !== params.view.browserSessionId) {
        return createUnavailableReason(
            'browser_context_annotation_inactive',
            'captureFailed',
            'Browser annotation mode is not active for this view.',
        );
    }
    if (active.navigationGeneration !== params.view.navigationGeneration) {
        return createAnnotationStaleReason();
    }
    return null;
}

export function resolveProviderCaptureBindingUnavailable(params: Readonly<{
    result: Extract<BrowserAnnotationCaptureProviderResult, { status: 'captured' }>;
    view: BrowserControlViewState;
}>): BrowserContextUnavailableReason | null {
    if (
        params.result.browserSessionId !== params.view.browserSessionId
        || params.result.viewId !== params.view.viewId
        || params.result.navigationGeneration !== params.view.navigationGeneration
    ) {
        return createAnnotationStaleReason();
    }
    return null;
}

export type AttachActiveBrowserPageReferenceResult = BrowserContextAttachResult;

export function attachActiveBrowserPageReference(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    capturedAtMs: number;
}>): AttachActiveBrowserPageReferenceResult {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to attach.',
            ),
        };
    }

    const captured = captureBrowserPageReference({
        state: params.state,
        browserContextEnabled: params.browserContextEnabled,
        contextCapabilities: params.contextCapabilities,
        adapterCapabilities: params.view.adapterCapabilities,
        viewId: params.view.viewId,
        target: params.view.target,
        page: {
            url: params.view.currentUrl,
            title: params.view.title,
            faviconUrl: params.view.faviconUrl,
            navigationGeneration: params.view.navigationGeneration,
            capturedAtMs: params.capturedAtMs,
        },
    });

    if (captured.status !== 'captured') {
        return captured;
    }

    return attachBrowserContextToComposer(captured.state, {
        attachmentId: buildAttachmentId(captured.itemId),
        contextId: captured.itemId,
    });
}

export type StartActiveBrowserAnnotationModeResult = BrowserAnnotationModeResult;

export function startActiveBrowserAnnotationMode(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    startedAtMs: number;
}>): StartActiveBrowserAnnotationModeResult {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to annotate.',
            ),
        };
    }

    return startBrowserAnnotationMode(params.state, {
        browserContextEnabled: params.browserContextEnabled,
        attachmentsUploadsEnabled: params.attachmentsUploadsEnabled,
        contextCapabilities: params.contextCapabilities,
        adapterCapabilities: params.view.adapterCapabilities,
        browserSessionId: params.view.browserSessionId,
        viewId: params.view.viewId,
        navigationGeneration: params.view.navigationGeneration,
        startedAtMs: params.startedAtMs,
    });
}

export function cancelActiveBrowserAnnotationMode(params: Readonly<{
    state: BrowserContextState;
    view: BrowserControlViewState | null;
}>): BrowserContextState {
    if (!params.view) return params.state;
    return cancelBrowserAnnotationMode(params.state, { viewId: params.view.viewId });
}

export function attachActiveBrowserAnnotation(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    draft: BrowserAnnotationDraftInput | null | undefined;
    capturedAtMs: number;
}>): BrowserContextAttachResult {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to annotate.',
            ),
        };
    }

    if (!params.draft) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_annotation_inactive',
                'captureFailed',
                'No browser annotation draft is available to attach.',
            ),
        };
    }

    const captured = captureBrowserAnnotation({
        state: params.state,
        browserContextEnabled: params.browserContextEnabled,
        browserDiagnosticsEnabled: params.browserDiagnosticsEnabled,
        attachmentsUploadsEnabled: params.attachmentsUploadsEnabled,
        contextCapabilities: params.contextCapabilities,
        adapterCapabilities: params.view.adapterCapabilities,
        browserSessionId: params.view.browserSessionId,
        viewId: params.view.viewId,
        navigationGeneration: params.view.navigationGeneration,
        capturedAtMs: params.capturedAtMs,
        media: params.draft.media,
        target: params.draft.target,
        comment: params.draft.comment,
        styleIntent: params.draft.styleIntent,
        stroke: params.draft.stroke,
        pageUrl: params.draft.pageUrl ?? params.view.currentUrl,
        pageTitle: params.draft.pageTitle ?? params.view.title,
    });

    if (captured.status !== 'captured') {
        return captured;
    }

    return attachBrowserContextToComposer(captured.state, {
        attachmentId: buildAttachmentId(captured.itemId),
        contextId: captured.itemId,
    });
}

export async function attachActiveBrowserAnnotationFromCaptureProvider(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    captureProvider: BrowserAnnotationCaptureProvider | null | undefined;
    capturedAtMs: number;
    resolveBinding: () => ActiveBrowserAnnotationBinding;
}>): Promise<BrowserContextAttachResult> {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to annotate.',
            ),
        };
    }

    const resolveAdmission = createActiveBrowserAnnotationCaptureAdmission({ binding: params, resolveBinding: params.resolveBinding });
    const activeUnavailable = resolveAdmission();
    if (activeUnavailable) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: activeUnavailable,
        };
    }

    if (!params.captureProvider || !params.captureProvider.available) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createAnnotationCaptureUnavailableReason(),
        };
    }

    let providerResult: BrowserAnnotationCaptureProviderResult;
    try {
        providerResult = await params.captureProvider.captureAnnotation({
            browserSessionId: params.view.browserSessionId,
            viewId: params.view.viewId,
            navigationGeneration: params.view.navigationGeneration,
            capturedAtMs: params.capturedAtMs,
            adapterKind: params.view.adapterKind,
            browserTarget: params.view.target,
            currentUrl: params.view.currentUrl,
            title: params.view.title,
            securityOrigin: params.view.securityOrigin,
            resolveAdmission,
        });
    } catch {
        const current = params.resolveBinding();
        return {
            status: 'unavailable',
            state: current.state,
            reason: resolveAdmission() ?? createAnnotationCaptureFailedReason(),
        };
    }

    const current = params.resolveBinding();
    const resultDenial = resolveAdmission();
    if (resultDenial || !current.view) {
        return { status: 'unavailable', state: current.state, reason: resultDenial ?? createAnnotationStaleReason() };
    }
    if (providerResult.status === 'unavailable') {
        return {
            status: 'unavailable',
            state: current.state,
            reason: providerResult.reason ?? createAnnotationCaptureUnavailableReason(),
        };
    }

    const staleReason = resolveProviderCaptureBindingUnavailable({
        result: providerResult,
        view: current.view,
    });
    if (staleReason) {
        return {
            status: 'unavailable',
            state: current.state,
            reason: staleReason,
        };
    }

    try {
        return attachActiveBrowserAnnotation({
            ...current,
            draft: {
                media: providerResult.media,
                target: providerResult.target,
                comment: providerResult.comment,
                styleIntent: providerResult.styleIntent,
                stroke: providerResult.stroke,
                pageUrl: providerResult.pageUrl,
                pageTitle: providerResult.pageTitle,
            },
            capturedAtMs: providerResult.capturedAtMs ?? params.capturedAtMs,
        });
    } catch {
        return {
            status: 'unavailable',
            state: current.state,
            reason: createAnnotationCaptureFailedReason(),
        };
    }
}
