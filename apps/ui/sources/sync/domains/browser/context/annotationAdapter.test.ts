import { describe, expect, it, vi } from 'vitest';
import type { BrowserContextCapabilities } from '@happier-dev/protocol';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { createBrowserContextAnnotationAdapter } from './annotationAdapter';
import { createBrowserContextState } from './state';
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
