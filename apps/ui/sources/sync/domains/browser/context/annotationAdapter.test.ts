import { describe, expect, it, vi } from 'vitest';
import { sanitizeSessionStructuredInputMeta, type BrowserContextCapabilities } from '@happier-dev/protocol';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { buildBrowserContextMessageMetaOverrides } from '@/sync/domains/session/input/browserContext';

import { createBrowserContextAnnotationAdapter } from './annotationAdapter';
import { createBrowserContextState, markBrowserContextViewNavigation } from './state';
import { createBrowserAnnotationCaptureProvider } from './captureProvider';
import type { BrowserAnnotationCaptureProvider, BrowserContextState } from './types';

const annotationCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    supportedAdapterKinds: ['localPreview', 'externalUrl'],
    screenshot: { supported: true, requiresAttachmentUploads: true },
    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

function buildView(): BrowserControlViewState {
    const base = buildBrowserAdapterCapabilities({
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
    });
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: { kind: 'localServicePreview', targetId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1' },
        platform: 'web',
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: {
            ...base,
            diagnosticsFidelityByFamily: {
                ...base.diagnosticsFidelityByFamily,
                screenshot: 'injectedPage',
                elements: 'injectedPage',
            },
            contextKinds: ['browserPageReference', 'browserAnnotation'],
        },
        currentUrl: 'https://preview.localhost.test/page',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Preview',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://preview.localhost.test',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
        navigationGeneration: 4,
    } as BrowserControlViewState;
}

function buildProvider(): BrowserAnnotationCaptureProvider {
    return {
        available: true,
        captureAnnotation: async (request) => ({
            status: 'captured',
            browserSessionId: request.browserSessionId,
            viewId: request.viewId,
            navigationGeneration: request.navigationGeneration,
            capturedAtMs: request.capturedAtMs,
            media: { mediaId: 'media_capture_1', mediaKind: 'image', width: 800, height: 600, sizeBytes: 50_000 },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 800, height: 600 } },
            pageUrl: request.currentUrl,
            pageTitle: request.title,
        }),
    };
}

describe('browser context annotation adapter', () => {
    it.each(['captureRegion', 'attachDraft'] as const)('admits %s before pixels and rechecks before upload', async (kind) => {
        let state = createBrowserContextState();
        let uploadsEnabled = true;
        let deferPixels = false;
        let finishPixels!: () => void;
        const pixelsReady = new Promise<void>((resolve) => { finishPixels = resolve; });
        const registerMedia = vi.fn(() => ({ mediaId: 'media', mediaKind: 'image' as const, width: 20, height: 20, sizeBytes: 1 }));
        const captureScreenshot = vi.fn(async () => {
            if (deferPixels) await pixelsReady;
            return { ok: true as const, snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 20, height: 20, sizeBytes: 1 } };
        });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view: buildView(), browserContextEnabled: true,
                browserDiagnosticsEnabled: true, attachmentsUploadsEnabled: uploadsEnabled,
                contextCapabilities: annotationCapabilities,
                captureProvider: createBrowserAnnotationCaptureProvider({ captureScreenshot, registerMedia }) }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 0, y: 0, width: 20, height: 20 } });
        uploadsEnabled = false;
        expect(await adapter.dispatch({ kind })).toMatchObject({ status: 'unavailable', reason: { reasonCode: 'browser_context_attachment_uploads_disabled' } });
        expect(captureScreenshot).not.toHaveBeenCalled();
        uploadsEnabled = true;
        deferPixels = true;
        const pending = adapter.dispatch({ kind });
        await Promise.resolve();
        uploadsEnabled = false;
        finishPixels();
        expect(await pending).toMatchObject({ status: 'unavailable', reason: { reasonCode: 'browser_context_attachment_uploads_disabled' } });
        expect(registerMedia).not.toHaveBeenCalled();
        expect(state.attachmentOrder).toEqual([]);
    });

    it.each(['captureRegion', 'attachDraft'] as const)('rejects %s after navigation during upload without restoring old state', async (kind) => {
        let state = createBrowserContextState();
        let view = buildView();
        let finishUpload!: () => void;
        const uploaded = new Promise<void>((resolve) => { finishUpload = resolve; });
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: true, snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 20, height: 20, sizeBytes: 1 } }),
            registerMedia: async () => { await uploaded; return { mediaId: 'media', mediaKind: 'image', width: 20, height: 20, sizeBytes: 1 }; },
        });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view, browserContextEnabled: true, browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities, captureProvider: provider }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 0, y: 0, width: 20, height: 20 } });
        const pending = adapter.dispatch({ kind });
        await Promise.resolve();
        view = { ...view, navigationGeneration: 5 };
        state = markBrowserContextViewNavigation(state, { viewId: view.viewId, navigationGeneration: 5 });
        const afterNavigation = state;
        finishUpload();
        expect(await pending).toMatchObject({ status: 'unavailable', reason: { reasonCode: 'browser_context_annotation_stale' } });
        expect(state).toBe(afterNavigation);
        expect(state.attachmentOrder).toEqual([]);
    });

    it.each(['captureRegion', 'attachDraft'] as const)('does not attach %s into a replacement annotation mode on the same page', async (kind) => {
        let state = createBrowserContextState();
        let finishUpload!: () => void;
        const uploaded = new Promise<void>((resolve) => { finishUpload = resolve; });
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: true, snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 20, height: 20, sizeBytes: 1 } }),
            registerMedia: async () => { await uploaded; return { mediaId: 'media', mediaKind: 'image', width: 20, height: 20, sizeBytes: 1 }; },
        });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view: buildView(), browserContextEnabled: true,
                attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities, captureProvider: provider, nowMs: () => 1_000 }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 0, y: 0, width: 20, height: 20 } });
        const pending = adapter.dispatch({ kind });
        await adapter.dispatch({ kind: 'cancel' });
        await adapter.dispatch({ kind: 'start' });
        const replacement = state;
        finishUpload();
        expect(await pending).toMatchObject({ status: 'unavailable', reason: { reasonCode: 'browser_context_annotation_stale' } });
        expect(state).toBe(replacement);
        expect(state.attachmentOrder).toEqual([]);
    });

    it('preserves a comment edited while the grouped upload is pending', async () => {
        let state = createBrowserContextState();
        let finishUpload!: () => void;
        const uploaded = new Promise<void>((resolve) => { finishUpload = resolve; });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view: buildView(), browserContextEnabled: true,
                browserDiagnosticsEnabled: true, attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities,
                captureProvider: createBrowserAnnotationCaptureProvider({
                    captureScreenshot: () => ({ ok: true, snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 20, height: 20, sizeBytes: 1 } }),
                    registerMedia: async () => { await uploaded; return { mediaId: 'media', mediaKind: 'image', width: 20, height: 20, sizeBytes: 1 }; },
                }) }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 0, y: 0, width: 20, height: 20 } });
        const pending = adapter.dispatch({ kind: 'attachDraft' });
        await adapter.dispatch({ kind: 'setDraftComment', comment: 'Edited during upload' });
        finishUpload();
        const result = await pending;
        expect(result.status).toBe('committed');
        if (result.status !== 'committed') throw new Error('Expected commit');
        expect(state.itemsById[result.itemIds[0]]).toMatchObject({ comment: 'Edited during upload' });
    });

    it('preserves changed geometry instead of committing an earlier grouped crop', async () => {
        let state = createBrowserContextState();
        let finishUpload!: () => void;
        const uploaded = new Promise<void>((resolve) => { finishUpload = resolve; });
        const provider = createBrowserAnnotationCaptureProvider({
            captureScreenshot: () => ({ ok: true, snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 20, height: 20, sizeBytes: 1 } }),
            registerMedia: async () => { await uploaded; return { mediaId: 'media', mediaKind: 'image', width: 20, height: 20, sizeBytes: 1 }; },
        });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view: buildView(), browserContextEnabled: true,
                attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities, captureProvider: provider }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 0, y: 0, width: 20, height: 20 } });
        const pending = adapter.dispatch({ kind: 'attachDraft' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 30, y: 0, width: 20, height: 20 } });
        const edited = state;
        finishUpload();
        expect(await pending).toMatchObject({ status: 'unavailable', reason: { reasonCode: 'browser_context_annotation_stale' } });
        expect(state).toBe(edited);
        expect(state.annotationDraftByViewId.view_1?.regions).toHaveLength(2);
        expect(state.attachmentOrder).toEqual([]);
    });

    it('drives start → captureRegion → comment/stroke/style through the canonical reducers', async () => {
        let state = createBrowserContextState();
        const onStateChange = vi.fn((next: BrowserContextState) => { state = next; });
        const view = buildView();
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state,
                view,
                browserContextEnabled: true,
                browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true,
                contextCapabilities: annotationCapabilities,
                captureProvider: buildProvider(),
                nowMs: () => 5_000,
            }),
            onStateChange,
        });

        const started = await adapter.dispatch({ kind: 'start' });
        expect(started.status).toBe('started');
        expect(state.activeAnnotationByViewId.view_1).toBeDefined();

        const captured = await adapter.dispatch({
            kind: 'captureRegion',
            target: { kind: 'region', rect: { x: 10, y: 20, width: 100, height: 80 } },
            styleIntent: 'callout',
        });
        expect(captured.status).toBe('captured');
        if (captured.status !== 'captured') return;
        const item = state.itemsById[captured.contextId];
        expect(item).toMatchObject({
            kind: 'browserAnnotation',
            // The caller-supplied region target overrides the provider's full-page target.
            target: { kind: 'region', rect: { x: 10, y: 20, width: 100, height: 80 } },
            styleIntent: 'callout',
            media: { mediaId: 'media_capture_1' },
        });

        const commented = await adapter.dispatch({
            kind: 'attachComment',
            contextId: captured.contextId,
            comment: 'Align the CTA',
        });
        expect(commented.status).toBe('updated');

        const stroked = await adapter.dispatch({
            kind: 'attachStroke',
            contextId: captured.contextId,
            stroke: { shape: 'arrow', points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }] },
        });
        expect(stroked.status).toBe('updated');

        const styled = await adapter.dispatch({
            kind: 'attachStyleIntent',
            contextId: captured.contextId,
            styleIntent: 'highlight',
        });
        expect(styled.status).toBe('updated');

        expect(state.itemsById[captured.contextId]).toMatchObject({
            comment: 'Align the CTA',
            stroke: { shape: 'arrow' },
            styleIntent: 'highlight',
        });
    });

    it('fails closed when no capture provider is available for a region capture', async () => {
        const state = createBrowserContextState();
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state,
                view: buildView(),
                browserContextEnabled: true,
                browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true,
                contextCapabilities: annotationCapabilities,
                captureProvider: null,
                nowMs: () => 5_000,
            }),
            onStateChange: vi.fn(),
        });
        const result = await adapter.dispatch({
            kind: 'captureRegion',
            target: { kind: 'region', rect: { x: 0, y: 0, width: 10, height: 10 } },
        });
        expect(result.status).toBe('unavailable');
    });

    it('captures an element-target annotation (element-picker bridge) through the provider', async () => {
        let state = createBrowserContextState();
        const onStateChange = vi.fn((next: BrowserContextState) => { state = next; });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state,
                view: buildView(),
                browserContextEnabled: true,
                browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true,
                contextCapabilities: annotationCapabilities,
                captureProvider: buildProvider(),
                nowMs: () => 6_000,
            }),
            onStateChange,
        });
        await adapter.dispatch({ kind: 'start' });
        const captured = await adapter.dispatch({
            kind: 'captureElement',
            target: { kind: 'element', selectorPath: 'main > button.cta', accessibleName: 'Buy now' },
        });
        expect(captured.status).toBe('captured');
        if (captured.status !== 'captured') return;
        expect(state.itemsById[captured.contextId]).toMatchObject({
            kind: 'browserAnnotation',
            target: { kind: 'element', selectorPath: 'main > button.cta', accessibleName: 'Buy now' },
        });
    });

    it('commits a stroke-only draft as an attachable cropped annotation group', async () => {
        let state = createBrowserContextState();
        const captureRequests: unknown[] = [];
        const onStateChange = vi.fn((next: BrowserContextState) => { state = next; });
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state,
                view: buildView(),
                browserContextEnabled: true,
                browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true,
                contextCapabilities: annotationCapabilities,
                captureProvider: {
                    available: true,
                    captureAnnotation: async (request) => {
                        captureRequests.push(request);
                        return {
                            status: 'captured',
                            browserSessionId: request.browserSessionId,
                            viewId: request.viewId,
                            navigationGeneration: request.navigationGeneration,
                            capturedAtMs: request.capturedAtMs,
                            media: {
                                mediaId: 'media_stroke_crop_1',
                                mediaKind: 'image',
                                width: 64,
                                height: 48,
                                sizeBytes: 12_000,
                            },
                            target: { kind: 'region', rect: { x: 0, y: 0, width: 64, height: 48 } },
                        };
                    },
                },
                devicePixelRatio: 2,
                nowMs: () => 7_000,
            }),
            onStateChange,
        });

        expect(await adapter.dispatch({ kind: 'start' })).toMatchObject({ status: 'started' });
        expect(await adapter.dispatch({
            kind: 'addDraftStroke',
            stroke: {
                shape: 'freehand',
                points: [{ x: 10, y: 20 }, { x: 40, y: 60 }],
                widthPx: 3,
            },
        })).toMatchObject({ status: 'draftUpdated' });

        const committed = await adapter.dispatch({ kind: 'attachDraft' });
        expect(committed.status).toBe('committed');
        if (committed.status !== 'committed') return;
        expect(captureRequests[0]).toMatchObject({
            cropClip: {
                cssViewportRect: { x: 10, y: 20, width: 30, height: 40 },
                scale: 2,
            },
        });
        expect(committed.itemIds).toHaveLength(1);
        const item = state.itemsById[committed.itemIds[0]];
        expect(item).toMatchObject({
            kind: 'browserAnnotation',
            media: { mediaId: 'media_stroke_crop_1' },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 30, height: 40 } },
            stroke: {
                shape: 'freehand',
                points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                widthPx: 3,
            },
        });
    });

    it('attaches every draft mark as one card admitted into the canonical model context', async () => {
        let state = createBrowserContextState();
        const view = { ...buildView(), currentUrl: 'https://preview.localhost.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?token=secret#secret' };
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state,
                view,
                browserContextEnabled: true,
                browserDiagnosticsEnabled: true,
                attachmentsUploadsEnabled: true,
                contextCapabilities: annotationCapabilities,
                captureProvider: buildProvider(),
                nowMs: () => 8_000,
            }),
            onStateChange: (next) => { state = next; },
        });
        await adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 10, y: 20, width: 30, height: 40 } });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 80, y: 90, width: 20, height: 10 } });
        await adapter.dispatch({ kind: 'setDraftComment', comment: 'Compare both marked areas' });
        const committed = await adapter.dispatch({ kind: 'attachDraft' });
        expect(committed.status).toBe('committed');
        if (committed.status !== 'committed') throw new Error('Draft did not commit');

        const message = buildBrowserContextMessageMetaOverrides({ state });
        expect(message.ok).toBe(true);
        if (!message.ok) throw new Error(message.reasonCode);
        expect(sanitizeSessionStructuredInputMeta(message.metaOverrides)).toMatchObject({
            happierStructuredInputV1: {
                browserContext: {
                    contexts: committed.itemIds.map((contextId) => ({ contextId, pageUrl: 'https://preview.localhost.test/reset/:redacted' })),
                    attachments: [{
                        structuredBlock: {
                            contextIds: committed.itemIds,
                            regions: [{ rect: { x: 0, y: 0, width: 30, height: 40 } },
                                { rect: { x: 70, y: 70, width: 20, height: 10 } }],
                            comment: 'Compare both marked areas',
                            pageUrl: 'https://preview.localhost.test/reset/:redacted',
                            screenshot: { media: [{ mediaId: 'media_capture_1' }] },
                        },
                    }],
                },
            },
        });
        expect(state.attachmentOrder).toHaveLength(1);
    });

    it('fails closed with a view-unavailable reason when no active view is bound', async () => {
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({
                state: createBrowserContextState(),
                view: null,
                browserContextEnabled: true,
                contextCapabilities: annotationCapabilities,
            }),
            onStateChange: vi.fn(),
        });
        const result = await adapter.dispatch({ kind: 'start' });
        expect(result).toMatchObject({ status: 'unavailable', reason: 'browser_context_view_unavailable' });
    });
});
