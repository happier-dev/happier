import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveBrowserAnnotationCaptureCapability } from './annotationCaptureCapability';
import { flattenAnnotatedImage } from '@/components/ui/media/annotation/flattenImage';
import type { BrowserAnnotationCommitInput, BrowserAnnotationCommitResult } from '@/components/sessions/browser/commitBrowserAnnotation';
import { captureBrowserSelectedElement } from './actions';

import {
    cancelActiveBrowserAnnotationMode,
    attachActiveBrowserPageReference,
    startActiveBrowserAnnotationMode,
} from './activeViewAttachment';
import {
    attachBrowserContextToComposer,
} from './state';
import {
    commitBrowserAnnotationDraft,
    setBrowserAnnotationDraftComment,
    startBrowserAnnotationDraft,
    readFrozenBrowserAnnotationDraft,
    clearBrowserAnnotationDraft,
    disposeBrowserAnnotationDraft,
    applyBrowserAnnotationOperations,
} from './annotationDraft';
import type {
    BrowserAnnotationCaptureProvider,
    BrowserContextState,
} from './types';
import type {
    BrowserAnnotationAdapterRequest,
    BrowserAnnotationAdapterResult,
    BrowserContextAnnotationAdapter,
    BrowserAnnotationDispatchTarget,
} from './runtimeAnnotationExecutor';

/**
 * Live binding the BrowserShell host exposes to the annotation adapter. Read freshly on every
 * dispatch so each action mutates the latest `BrowserContextState` (the reducer is pure; the host
 * commits via `onStateChange`). The provider freezes the viewport before marks are authored.
 */
export type BrowserAnnotationAdapterBinding = Readonly<{
    state: BrowserContextState;
    view: BrowserControlViewState | null;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    captureProvider?: BrowserAnnotationCaptureProvider | null;
    commitAnnotation?: (input: BrowserAnnotationCommitInput) => Promise<BrowserAnnotationCommitResult>;
    nowMs?: () => number;
}>;

function viewUnavailable(): Extract<BrowserAnnotationAdapterResult, { status: 'unavailable' }> {
    return {
        status: 'unavailable',
        reason: 'browser_context_view_unavailable',
    };
}

function buildAttachmentId(contextId: string): string {
    return `browser_context_attachment:${contextId}`;
}

/**
 * Builds the canonical in-app annotation and page-attachment adapter. Each mounted context
 * action maps to the existing `activeViewAttachment`/reducer owners; a successful capture/edit is
 * committed through `onStateChange` and the captured item's attachment id is returned to the caller
 * so the front-door result carries a real handle. This is the single owner the BrowserShell toolbar
 * handlers AND an agent dispatch both flow through (via the runtime executor front door).
 */
export function createBrowserContextAnnotationAdapter(input: Readonly<{
    resolveBinding: () => BrowserAnnotationAdapterBinding;
    onStateChange: (state: BrowserContextState) => void;
}>): BrowserContextAnnotationAdapter {
    let pendingStart: Readonly<{
        browserSessionId: string; viewId: string; navigationGeneration: number;
        controller: AbortController; result: Promise<BrowserAnnotationAdapterResult>;
    }> | null = null;
    return {
        captureSelectedElement(pickerResult) {
            const binding = input.resolveBinding();
            if (!binding.view) return viewUnavailable();
            if (pickerResult.viewId !== binding.view.viewId || pickerResult.navigationGeneration !== binding.view.navigationGeneration) {
                return { status: 'unavailable', reason: 'browser_context_annotation_stale' };
            }
            const captured = captureBrowserSelectedElement({ ...binding, adapterCapabilities: binding.view.adapterCapabilities,
                capturedAtMs: binding.nowMs?.() ?? Date.now(), pickerResult });
            if (captured.status !== 'captured') return { status: 'unavailable', reason: captured.reason };
            const attachmentId = buildAttachmentId(captured.itemId);
            const attached = attachBrowserContextToComposer(captured.state, { attachmentId, contextId: captured.itemId });
            if (attached.status !== 'attached') return { status: 'unavailable', reason: attached.reason };
            input.onStateChange(attached.state);
            return { status: 'captured', state: attached.state, contextId: captured.itemId, attachmentId };
        },
        readFrozenDraft() {
            const binding = input.resolveBinding();
            const draft = binding.view ? readFrozenBrowserAnnotationDraft(binding.state, binding.view.viewId) : null;
            return draft ? { source: draft.source, document: draft.document } : null;
        },
        async applyOperations(request) {
            const binding = input.resolveBinding();
            if (!binding.view || !readFrozenBrowserAnnotationDraft(binding.state, binding.view.viewId)) return false;
            const next = applyBrowserAnnotationOperations(binding.state, { viewId: binding.view.viewId,
                operations: request.reset ? [{ kind: 'reset' }] : request.operations ?? [] });
            if (next !== binding.state) input.onStateChange(next);
            return true;
        },
        async dispatch(request: BrowserAnnotationAdapterRequest, target?: BrowserAnnotationDispatchTarget): Promise<BrowserAnnotationAdapterResult> {
            const binding = input.resolveBinding();
            if (!binding.view) return viewUnavailable();
            if (target && (target.signal?.aborted || binding.view.browserSessionId !== target.browserSessionId
                || binding.view.viewId !== target.viewId
                || (target.navigationGeneration !== undefined && binding.view.navigationGeneration !== target.navigationGeneration))) {
                return { status: 'unavailable', reason: 'browser_context_annotation_stale' };
            }

            switch (request.kind) {
                case 'attachPageReference': {
                    const result = attachActiveBrowserPageReference({ ...binding, capturedAtMs: binding.nowMs?.() ?? Date.now() });
                    if (result.status !== 'attached') return { status: 'unavailable', reason: result.reason };
                    input.onStateChange(result.state);
                    return result;
                }
                case 'start': {
                    const existing = readFrozenBrowserAnnotationDraft(binding.state, binding.view.viewId);
                    if (existing?.browserSessionId === binding.view.browserSessionId
                        && existing.navigationGeneration === binding.view.navigationGeneration) {
                        return { status: 'started', state: binding.state };
                    }
                    const captureCapability = resolveBrowserAnnotationCaptureCapability({
                        adapterKind: binding.view.adapterKind,
                        primaryEngine: binding.view.engineKind,
                        captureSourceAvailable: binding.captureProvider?.available === true,
                    });
                    if (!captureCapability.available) {
                        return { status: 'unavailable', reason: captureCapability.disabledReason };
                    }
                    const result = startActiveBrowserAnnotationMode({
                        state: binding.state,
                        browserContextEnabled: binding.browserContextEnabled,
                        attachmentsUploadsEnabled: binding.attachmentsUploadsEnabled,
                        contextCapabilities: binding.contextCapabilities,
                        view: binding.view,
                        startedAtMs: binding.nowMs?.() ?? Date.now(),
                    });
                    if (result.status !== 'started') {
                        return { status: 'unavailable', reason: result.reason };
                    }
                    if (!binding.captureProvider?.captureViewport || !binding.commitAnnotation) {
                        return { status: 'unavailable', reason: 'browser_context_annotation_capture_unavailable' };
                    }
                    return startFrozenDraft(binding.view, binding.captureProvider.captureViewport,
                        result.state.activeAnnotationByViewId[binding.view.viewId]!, target?.signal);
                }
                case 'cancel': {
                    if (pendingStart?.viewId === binding.view.viewId && pendingStart.browserSessionId === binding.view.browserSessionId) {
                        pendingStart.controller.abort();
                    }
                    const draft = readFrozenBrowserAnnotationDraft(binding.state, binding.view.viewId);
                    if (draft) disposeBrowserAnnotationDraft(draft);
                    const cancelled = cancelActiveBrowserAnnotationMode({
                        state: binding.state,
                        view: binding.view,
                    });
                    const state = draft ? clearBrowserAnnotationDraft(cancelled, { viewId: binding.view.viewId }) : cancelled;
                    input.onStateChange(state);
                    return { status: 'cancelled', state };
                }
                case 'setDraftComment': {
                    const next = setBrowserAnnotationDraftComment(binding.state, {
                        viewId: binding.view.viewId,
                        comment: request.comment,
                    });
                    input.onStateChange(next);
                    return { status: 'draftUpdated', state: next };
                }
                case 'attachDraft':
                    return commitDraft(binding, target);
            }
        },
    };

    function startFrozenDraft(view: BrowserControlViewState,
        captureViewport: NonNullable<BrowserAnnotationCaptureProvider['captureViewport']>,
        mode: BrowserContextState['activeAnnotationByViewId'][string], signal?: AbortSignal): Promise<BrowserAnnotationAdapterResult> {
        if (pendingStart && !pendingStart.controller.signal.aborted && pendingStart.viewId === view.viewId
            && pendingStart.browserSessionId === view.browserSessionId && pendingStart.navigationGeneration === view.navigationGeneration) {
            return pendingStart.result;
        }
        pendingStart?.controller.abort();
        const controller = new AbortController();
        const result = (async (): Promise<BrowserAnnotationAdapterResult> => {
            const captured = await captureViewport({ browserSessionId: view.browserSessionId, viewId: view.viewId,
                navigationGeneration: view.navigationGeneration, capturedAtMs: mode.startedAtMs, adapterKind: view.adapterKind,
                browserTarget: view.target, currentUrl: view.currentUrl, title: view.title, securityOrigin: view.securityOrigin });
            if (captured.status !== 'captured') return { status: 'unavailable', reason: captured.reason };
            if (controller.signal.aborted || signal?.aborted) {
                await captured.dispose?.();
                return { status: 'unavailable', reason: 'browser_context_annotation_capture_unavailable' };
            }
            const current = input.resolveBinding().state;
            const previous = readFrozenBrowserAnnotationDraft(current, view.viewId);
            if (previous) disposeBrowserAnnotationDraft(previous);
            const next = startBrowserAnnotationDraft({ ...current, activeAnnotationByViewId: {
                ...current.activeAnnotationByViewId, [view.viewId]: mode,
            } }, { browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
                source: captured.source, capture: captured.capture, dispose: captured.dispose,
                pageUrl: captured.pageUrl ?? view.currentUrl ?? undefined, pageTitle: captured.pageTitle ?? view.title ?? undefined,
                nowMs: mode.startedAtMs });
            input.onStateChange(next);
            return { status: 'started', state: next };
        })().finally(() => { if (pendingStart?.result === result) pendingStart = null; });
        pendingStart = { browserSessionId: view.browserSessionId, viewId: view.viewId,
            navigationGeneration: view.navigationGeneration, controller, result };
        return result;
    }

    async function commitDraft(
        binding: BrowserAnnotationAdapterBinding,
        target?: BrowserAnnotationDispatchTarget,
    ): Promise<BrowserAnnotationAdapterResult> {
        if (!binding.view) return viewUnavailable();
        const frozen = readFrozenBrowserAnnotationDraft(binding.state, binding.view.viewId);
        if (!frozen) return { status: 'unavailable', reason: 'browser_context_annotation_inactive' };
        if (!binding.commitAnnotation) return { status: 'unavailable', reason: 'annotation.targetUnavailable' };
        const flattened = await flattenAnnotatedImage(frozen.source, frozen.document);
        if (!flattened.ok) return { status: 'unavailable', reason: `flatten.${flattened.reason}` };
        if (target?.signal?.aborted) return { status: 'unavailable', reason: 'browser_context_annotation_capture_unavailable' };
        const picture = await binding.commitAnnotation({ ...flattened, original: frozen.source, document: frozen.document,
            comment: frozen.comment ?? '', annotationId: frozen.annotationId });
        if (!picture.ok) return { status: 'unavailable', reason: picture.reason };
        const committed = commitBrowserAnnotationDraft({ state: input.resolveBinding().state,
            browserSessionId: frozen.browserSessionId, viewId: frozen.viewId, navigationGeneration: frozen.navigationGeneration,
            adapterKind: binding.view.adapterKind, draft: frozen, imageRef: picture.imageRef, capturedAtMs: frozen.createdAtMs });
        if (committed.status !== 'committed') return { status: 'unavailable', reason: committed.reason };
        const attached = attachBrowserContextToComposer(committed.state, {
            attachmentId: buildAttachmentId(committed.annotationId), contextId: committed.itemIds[0]!,
        });
        if (attached.status !== 'attached') return { status: 'unavailable', reason: attached.reason };
        disposeBrowserAnnotationDraft(frozen);
        input.onStateChange(attached.state);
        return { status: 'committed', state: attached.state, annotationId: committed.annotationId, itemIds: committed.itemIds };
    }
}

export { buildAttachmentId };
