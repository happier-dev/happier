import type { BrowserContextCapabilities } from '@happier-dev/protocol';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import {
    cancelActiveBrowserAnnotationMode,
    startActiveBrowserAnnotationMode,
    attachActiveBrowserAnnotation,
    attachActiveBrowserAnnotationFromCaptureProvider,
} from './activeViewAttachment';
import {
    updateBrowserAnnotationComment,
    updateBrowserAnnotationStroke,
    updateBrowserAnnotationStyleIntent,
} from './state';
import {
    addBrowserAnnotationDraftRegion,
    addBrowserAnnotationDraftStroke,
    addBrowserAnnotationDraftTarget,
    commitBrowserAnnotationDraft,
    countBrowserAnnotationDraftMarks,
    readBrowserAnnotationDraft,
    removeBrowserAnnotationDraftTarget,
    resolveBrowserAnnotationDraftCropClip,
    setBrowserAnnotationDraftComment,
} from './annotationDraft';
import type {
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationDraftInput,
    BrowserContextState,
} from './types';
import type {
    BrowserAnnotationAdapterRequest,
    BrowserAnnotationAdapterResult,
    BrowserContextAnnotationAdapter,
} from './runtimeAnnotationExecutor';

/**
 * Live binding the BrowserShell host exposes to the annotation adapter. Read freshly on every
 * dispatch so each action mutates the latest `BrowserContextState` (the reducer is pure; the host
 * commits via `onStateChange`). The capture provider produces the screenshot media draft when a
 * region/element capture has no caller-supplied draft.
 */
export type BrowserAnnotationAdapterBinding = Readonly<{
    state: BrowserContextState;
    view: BrowserControlViewState | null;
    browserContextEnabled: boolean;
    browserDiagnosticsEnabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    captureProvider?: BrowserAnnotationCaptureProvider | null;
    /**
     * A pre-produced annotation draft (media + target) supplied by the host. Used as the capture
     * source when no live capture provider is available (e.g. a host that captured media through a
     * different producer, or a test fixture). A caller-supplied target on the request overrides the
     * draft's target.
     */
    annotationDraft?: BrowserAnnotationDraftInput | null;
    /**
     * ANNO-3: device-pixel ratio of the captured view, used to convert the editor's CSS-viewport
     * draft geometry into the device-pixel crop the capture producer clips to. Defaults to the host
     * window DPR (`globalThis.devicePixelRatio`) and finally `1`.
     */
    devicePixelRatio?: number;
    nowMs?: () => number;
}>;

function resolveBindingDevicePixelRatio(binding: BrowserAnnotationAdapterBinding): number {
    if (typeof binding.devicePixelRatio === 'number' && binding.devicePixelRatio > 0) {
        return binding.devicePixelRatio;
    }
    const hostRatio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    return typeof hostRatio === 'number' && hostRatio > 0 ? hostRatio : 1;
}

function viewUnavailable(): BrowserAnnotationAdapterResult {
    return {
        status: 'unavailable',
        reason: 'browser_context_view_unavailable',
    };
}

function buildAttachmentId(contextId: string): string {
    return `browser_context_attachment:${contextId}`;
}

/**
 * Builds the canonical in-app annotation adapter. Each of the seven `browser.context.annotation.*`
 * actions maps to the existing `activeViewAttachment`/reducer owners; a successful capture/edit is
 * committed through `onStateChange` and the captured item's attachment id is returned to the caller
 * so the front-door result carries a real handle. This is the single owner the BrowserShell toolbar
 * handlers AND an agent dispatch both flow through (via the runtime executor front door).
 */
export function createBrowserContextAnnotationAdapter(input: Readonly<{
    resolveBinding: () => BrowserAnnotationAdapterBinding;
    onStateChange: (state: BrowserContextState) => void;
}>): BrowserContextAnnotationAdapter {
    function captureFromDraft(
        binding: BrowserAnnotationAdapterBinding,
        draft: BrowserAnnotationDraftInput,
    ) {
        return attachActiveBrowserAnnotation({
            state: binding.state,
            browserContextEnabled: binding.browserContextEnabled,
            browserDiagnosticsEnabled: binding.browserDiagnosticsEnabled,
            attachmentsUploadsEnabled: binding.attachmentsUploadsEnabled,
            contextCapabilities: binding.contextCapabilities,
            view: binding.view,
            draft,
            capturedAtMs: binding.nowMs?.() ?? Date.now(),
        });
    }

    return {
        async dispatch(request: BrowserAnnotationAdapterRequest): Promise<BrowserAnnotationAdapterResult> {
            const binding = input.resolveBinding();
            if (!binding.view) return viewUnavailable();

            switch (request.kind) {
                case 'start': {
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
                    input.onStateChange(result.state);
                    return { status: 'started', state: result.state };
                }
                case 'cancel': {
                    const state = cancelActiveBrowserAnnotationMode({
                        state: binding.state,
                        view: binding.view,
                    });
                    input.onStateChange(state);
                    return { status: 'cancelled', state };
                }
                case 'captureRegion':
                case 'captureElement': {
                    // A caller-supplied target (region rect or element selector, e.g. from the
                    // element-picker bridge) overrides the provider's own target so the captured
                    // annotation is bound to exactly the marked region/element; the provider still
                    // produces the screenshot media for the page snapshot.
                    const result = await captureRegionOrElement(binding, request);
                    if (result.status !== 'attached') {
                        return { status: 'unavailable', reason: result.reason };
                    }
                    input.onStateChange(result.state);
                    return {
                        status: 'captured',
                        state: result.state,
                        attachmentId: result.attachmentId,
                        contextId: result.attachmentId.replace(/^browser_context_attachment:/, ''),
                    };
                }
                case 'attachComment': {
                    const result = updateBrowserAnnotationComment(binding.state, {
                        contextId: request.contextId,
                        comment: request.comment,
                    });
                    if (result.status !== 'updated') {
                        return { status: 'unavailable', reason: result.reason };
                    }
                    input.onStateChange(result.state);
                    return { status: 'updated', state: result.state, contextId: request.contextId };
                }
                case 'attachStroke': {
                    const result = updateBrowserAnnotationStroke(binding.state, {
                        contextId: request.contextId,
                        stroke: request.stroke,
                    });
                    if (result.status !== 'updated') {
                        return { status: 'unavailable', reason: result.reason };
                    }
                    input.onStateChange(result.state);
                    return { status: 'updated', state: result.state, contextId: request.contextId };
                }
                case 'attachStyleIntent': {
                    const result = updateBrowserAnnotationStyleIntent(binding.state, {
                        contextId: request.contextId,
                        styleIntent: request.styleIntent,
                    });
                    if (result.status !== 'updated') {
                        return { status: 'unavailable', reason: result.reason };
                    }
                    input.onStateChange(result.state);
                    return { status: 'updated', state: result.state, contextId: request.contextId };
                }
                case 'addDraftTarget': {
                    const next = addBrowserAnnotationDraftTarget(binding.state, {
                        browserSessionId: binding.view.browserSessionId,
                        viewId: binding.view.viewId,
                        navigationGeneration: binding.view.navigationGeneration,
                        nowMs: binding.nowMs?.() ?? Date.now(),
                        target: request.target,
                    });
                    input.onStateChange(next);
                    return { status: 'draftUpdated', state: next };
                }
                case 'addDraftRegion': {
                    const next = addBrowserAnnotationDraftRegion(binding.state, {
                        browserSessionId: binding.view.browserSessionId,
                        viewId: binding.view.viewId,
                        navigationGeneration: binding.view.navigationGeneration,
                        nowMs: binding.nowMs?.() ?? Date.now(),
                        rect: request.rect,
                    });
                    input.onStateChange(next);
                    return { status: 'draftUpdated', state: next };
                }
                case 'addDraftStroke': {
                    const next = addBrowserAnnotationDraftStroke(binding.state, {
                        browserSessionId: binding.view.browserSessionId,
                        viewId: binding.view.viewId,
                        navigationGeneration: binding.view.navigationGeneration,
                        nowMs: binding.nowMs?.() ?? Date.now(),
                        stroke: request.stroke,
                    });
                    input.onStateChange(next);
                    return { status: 'draftUpdated', state: next };
                }
                case 'removeDraftTarget': {
                    const next = removeBrowserAnnotationDraftTarget(binding.state, {
                        viewId: binding.view.viewId,
                        draftId: request.draftId,
                    });
                    input.onStateChange(next);
                    return { status: 'draftUpdated', state: next };
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
                    return commitDraft(binding);
            }
        },
    };

    /**
     * ANNO-1 Attach: capture the union crop ONCE via the capture provider, then commit the editor
     * draft into N grouped `browserAnnotation` items sharing that single media + one annotationId.
     * Fails closed (disabled until ≥1 target) so an empty draft never produces a fabricated item.
     */
    async function commitDraft(
        binding: BrowserAnnotationAdapterBinding,
    ): Promise<BrowserAnnotationAdapterResult> {
        if (!binding.view) return viewUnavailable();
        if (countBrowserAnnotationDraftMarks(binding.state, binding.view.viewId) < 1) {
            return {
                status: 'unavailable',
                reason: 'browser_context_annotation_inactive',
            };
        }
        const capturedAtMs = binding.nowMs?.() ?? Date.now();
        const media = await resolveDraftMedia(binding, capturedAtMs);
        if (!media) {
            return {
                status: 'unavailable',
                reason: 'browser_context_annotation_capture_unavailable',
            };
        }
        const committed = commitBrowserAnnotationDraft({
            state: binding.state,
            browserSessionId: binding.view.browserSessionId,
            viewId: binding.view.viewId,
            navigationGeneration: binding.view.navigationGeneration,
            adapterKind: binding.view.adapterKind,
            media,
            capturedAtMs,
            pageUrl: binding.view.currentUrl,
            pageTitle: binding.view.title,
        });
        if (committed.status !== 'committed') {
            return { status: 'unavailable', reason: committed.reason };
        }
        input.onStateChange(committed.state);
        return {
            status: 'committed',
            state: committed.state,
            annotationId: committed.annotationId,
            itemIds: committed.itemIds,
        };
    }

    async function resolveDraftMedia(
        binding: BrowserAnnotationAdapterBinding,
        capturedAtMs: number,
    ) {
        if (binding.captureProvider?.available && binding.view) {
            // ANNO-3: resolve the union-of-targets crop from the live draft so the captured media is
            // clipped to the marked region (not the whole page). No draft geometry ⇒ full-frame.
            const draft = readBrowserAnnotationDraft(binding.state, binding.view.viewId);
            const cropClip = draft
                ? resolveBrowserAnnotationDraftCropClip(draft, {
                    devicePixelRatio: resolveBindingDevicePixelRatio(binding),
                })
                : null;
            const result = await binding.captureProvider.captureAnnotation({
                browserSessionId: binding.view.browserSessionId,
                viewId: binding.view.viewId,
                navigationGeneration: binding.view.navigationGeneration,
                capturedAtMs,
                adapterKind: binding.view.adapterKind,
                browserTarget: binding.view.target,
                currentUrl: binding.view.currentUrl,
                title: binding.view.title,
                securityOrigin: binding.view.securityOrigin,
                ...(cropClip ? { cropClip } : {}),
            });
            if (result.status === 'captured') return result.media;
            return null;
        }
        // No live capture provider: fall back to a host-supplied draft media reference if present.
        return binding.annotationDraft?.media ?? null;
    }

    async function captureRegionOrElement(
        binding: BrowserAnnotationAdapterBinding,
        request: Extract<BrowserAnnotationAdapterRequest, { kind: 'captureRegion' | 'captureElement' }>,
    ) {
        // When a target is supplied we still want the provider's captured media (page pixels).
        // Resolve the provider draft first (if any), then override the target + style fields.
        const capturedAtMs = binding.nowMs?.() ?? Date.now();
        if (binding.captureProvider?.available && binding.view) {
            const providerCaptured = await attachActiveBrowserAnnotationFromCaptureProvider({
                state: binding.state,
                browserContextEnabled: binding.browserContextEnabled,
                browserDiagnosticsEnabled: binding.browserDiagnosticsEnabled,
                attachmentsUploadsEnabled: binding.attachmentsUploadsEnabled,
                contextCapabilities: binding.contextCapabilities,
                view: binding.view,
                captureProvider: {
                    available: true,
                    captureAnnotation: async (providerRequest) => {
                        const result = await binding.captureProvider!.captureAnnotation(providerRequest);
                        if (result.status !== 'captured') return result;
                        return {
                            ...result,
                            // Override the provider's full-page target only when the caller supplied a
                            // specific target (marquee region or element-picker selector).
                            ...(request.target ? { target: request.target } : {}),
                            ...(request.comment ? { comment: request.comment } : {}),
                            ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
                            ...(request.stroke ? { stroke: request.stroke } : {}),
                        };
                    },
                },
                capturedAtMs,
            });
            return providerCaptured;
        }

        // No capture provider: fall back to a host-supplied draft (which already carries the media
        // reference). A request target overrides the draft target. Without a draft there are no
        // pixels to attach → fail-closed (honest, never a fabricated media reference).
        if (!binding.annotationDraft) {
            return {
                status: 'unavailable' as const,
                reason: {
                    reasonCode: 'browser_context_annotation_capture_unavailable' as const,
                    lifecycleState: 'adapterUnavailable' as const,
                    message: 'No annotation capture provider is available for this view.',
                },
            };
        }
        const draft: BrowserAnnotationDraftInput = {
            ...binding.annotationDraft,
            ...(request.target ? { target: request.target } : {}),
            ...(request.comment ? { comment: request.comment } : {}),
            ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
            ...(request.stroke ? { stroke: request.stroke } : {}),
        };
        return captureFromDraft(binding, draft);
    }
}

export { buildAttachmentId };
