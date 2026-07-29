import type { BrowserContextCapabilities } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { selectBrowserContextComposerAttachments } from './selectors';
import { createBrowserContextState } from './state';

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
    },
} as const;

const contextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: ['localPreview'],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const annotationContextCapabilities = {
    ...contextCapabilities,
    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    screenshot: {
        supported: true,
        requiresAttachmentUploads: true,
        maxBytes: 5_000_000,
    },
} satisfies BrowserContextCapabilities;

function createView(overrides: Partial<BrowserControlViewState> = {}): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target,
        platform: 'web',
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'https://preview.localhost.test/dashboard?previewToken=secret#fragment',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Dashboard',
        faviconUrl: 'https://preview.localhost.test/favicon.ico?token=secret',
        loadingState: 'ready',
        loadingProgress: 1,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://preview.localhost.test',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
        navigationGeneration: 2,
        ...overrides,
    };
}

function createAnnotationCapableView(overrides: Partial<BrowserControlViewState> = {}): BrowserControlViewState {
    const view = createView(overrides);
    return {
        ...view,
        adapterCapabilities: {
            ...view.adapterCapabilities,
            diagnosticsFidelityByFamily: {
                ...view.adapterCapabilities.diagnosticsFidelityByFamily,
                screenshot: 'injectedPage',
            },
            contextKinds: ['browserPageReference', 'browserAnnotation'],
        },
        ...overrides,
    };
}

describe('attachActiveBrowserPageReference', () => {
    it('captures the active browser view as a redacted composer attachment', async () => {
        const { attachActiveBrowserPageReference } = await import('./activeViewAttachment');

        const result = attachActiveBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            view: createView(),
            capturedAtMs: 5_000,
        });

        expect(result.status).toBe('attached');
        if (result.status !== 'attached') return;
        const attachmentRecord = result.state.attachmentsById[result.attachmentId];
        expect(attachmentRecord).toEqual(expect.objectContaining({
            attachmentId: result.attachmentId,
        }));
        const [attachment] = selectBrowserContextComposerAttachments(result.state);
        expect(attachment).toEqual(expect.objectContaining({
            attachmentId: result.attachmentId,
            capturedNavigationGeneration: 2,
            currentNavigationGeneration: 2,
            state: 'available',
        }));
        const item = result.state.itemsById[attachment!.contextId];
        expect(item).toEqual(expect.objectContaining({
            kind: 'browserPageReference',
            sourceViewId: 'view_1',
            sourceAdapterKind: 'localPreview',
            url: 'https://preview.localhost.test/dashboard',
            faviconUrl: 'https://preview.localhost.test/favicon.ico',
            title: 'Dashboard',
            navigationGeneration: 2,
            redactionLevel: 'metadataOnly',
        }));
        expect(JSON.stringify(item)).not.toContain('secret');
        expect(JSON.stringify(item)).not.toContain('fragment');
    });

    it('fails closed when no active browser view is available', async () => {
        const { attachActiveBrowserPageReference } = await import('./activeViewAttachment');

        const result = attachActiveBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            view: null,
            capturedAtMs: 5_000,
        });

        expect(result).toEqual({
            status: 'unavailable',
            state: createBrowserContextState(),
            reason: expect.objectContaining({
                reasonCode: 'browser_context_view_unavailable',
                lifecycleState: 'adapterUnavailable',
            }),
        });
    });
});

describe('attachActiveBrowserAnnotationFromCaptureProvider', () => {
    it('produces and attaches a media-backed annotation for the active view generation', async () => {
        const {
            attachActiveBrowserAnnotationFromCaptureProvider,
            startActiveBrowserAnnotationMode,
        } = await import('./activeViewAttachment');
        const view = createAnnotationCapableView();
        const started = startActiveBrowserAnnotationMode({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            startedAtMs: 5_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const result = await attachActiveBrowserAnnotationFromCaptureProvider({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            browserDiagnosticsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            capturedAtMs: 5_100,
            captureProvider: {
                available: true,
                captureAnnotation: async (request) => ({
                    status: 'captured',
                    browserSessionId: request.browserSessionId,
                    viewId: request.viewId,
                    navigationGeneration: request.navigationGeneration,
                    capturedAtMs: 5_125,
                    media: {
                        mediaId: 'media_annotation_provider_1',
                        mediaKind: 'image',
                        width: 1280,
                        height: 720,
                        sizeBytes: 300_000,
                    },
                    target: {
                        kind: 'region',
                        rect: { x: 12, y: 24, width: 240, height: 120 },
                    },
                    comment: '  Align this button.  ',
                    pageUrl: `${request.currentUrl}?token=secret#fragment`,
                    pageTitle: request.title,
                }),
            },
        });

        expect(result.status).toBe('attached');
        if (result.status !== 'attached') return;
        const [attachment] = selectBrowserContextComposerAttachments(result.state);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 2,
            currentNavigationGeneration: 2,
            state: 'available',
        }));
        const item = result.state.itemsById[attachment!.contextId];
        expect(item).toEqual(expect.objectContaining({
            kind: 'browserAnnotation',
            browserSessionId: 'browser_session_1',
            sourceViewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 5_125,
            media: expect.objectContaining({ mediaId: 'media_annotation_provider_1' }),
            target: expect.objectContaining({
                kind: 'region',
                rect: expect.objectContaining({ width: 240, height: 120 }),
            }),
            comment: 'Align this button.',
            pageUrl: 'https://preview.localhost.test/dashboard',
            pageTitle: 'Dashboard',
        }));
        expect(JSON.stringify(item)).not.toContain('secret');
        expect(result.state.activeAnnotationByViewId.view_1).toBeUndefined();
    });

    it('fails closed without attaching when annotation capture is unavailable', async () => {
        const {
            attachActiveBrowserAnnotationFromCaptureProvider,
            startActiveBrowserAnnotationMode,
        } = await import('./activeViewAttachment');
        const view = createAnnotationCapableView();
        const started = startActiveBrowserAnnotationMode({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            startedAtMs: 5_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const result = await attachActiveBrowserAnnotationFromCaptureProvider({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            capturedAtMs: 5_100,
            captureProvider: null,
        });

        expect(result).toMatchObject({
            status: 'unavailable',
            state: started.state,
            reason: {
                lifecycleState: 'adapterUnavailable',
                reasonCode: 'browser_context_annotation_capture_unavailable',
            },
        });
        expect(result.state.itemsById).toEqual({});
        expect(selectBrowserContextComposerAttachments(result.state)).toEqual([]);
    });

    it('rejects stale provider media instead of attaching it to a newer navigation', async () => {
        const {
            attachActiveBrowserAnnotationFromCaptureProvider,
            startActiveBrowserAnnotationMode,
        } = await import('./activeViewAttachment');
        const currentView = createAnnotationCapableView({
            navigationGeneration: 3,
            currentUrl: 'https://preview.localhost.test/next',
        });
        const started = startActiveBrowserAnnotationMode({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view: currentView,
            startedAtMs: 5_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const result = await attachActiveBrowserAnnotationFromCaptureProvider({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view: currentView,
            capturedAtMs: 5_100,
            captureProvider: {
                available: true,
                captureAnnotation: async () => ({
                    status: 'captured',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 2,
                    media: {
                        mediaId: 'media_annotation_stale',
                        mediaKind: 'image',
                        width: 1280,
                        height: 720,
                        sizeBytes: 300_000,
                    },
                    target: {
                        kind: 'region',
                        rect: { x: 0, y: 0, width: 100, height: 100 },
                    },
                }),
            },
        });

        expect(result).toMatchObject({
            status: 'unavailable',
            state: started.state,
            reason: {
                lifecycleState: 'navigationStale',
                reasonCode: 'browser_context_annotation_stale',
            },
        });
        expect(result.state.itemsById).toEqual({});
        expect(selectBrowserContextComposerAttachments(result.state)).toEqual([]);
    });

    it('returns a typed failure when provider output cannot be accepted as context', async () => {
        const {
            attachActiveBrowserAnnotationFromCaptureProvider,
            startActiveBrowserAnnotationMode,
        } = await import('./activeViewAttachment');
        const view = createAnnotationCapableView();
        const started = startActiveBrowserAnnotationMode({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            startedAtMs: 5_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const result = await attachActiveBrowserAnnotationFromCaptureProvider({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            view,
            capturedAtMs: 5_100,
            captureProvider: {
                available: true,
                captureAnnotation: async (request) => ({
                    status: 'captured',
                    browserSessionId: request.browserSessionId,
                    viewId: request.viewId,
                    navigationGeneration: request.navigationGeneration,
                    capturedAtMs: -1,
                    media: {
                        mediaId: 'media_annotation_invalid',
                        mediaKind: 'image',
                        width: 1280,
                        height: 720,
                        sizeBytes: 300_000,
                    },
                    target: {
                        kind: 'region',
                        rect: { x: 0, y: 0, width: 100, height: 100 },
                    },
                }),
            },
        });

        expect(result).toMatchObject({
            status: 'unavailable',
            state: started.state,
            reason: {
                lifecycleState: 'captureFailed',
                reasonCode: 'browser_context_annotation_capture_failed',
            },
        });
        expect(result.state.itemsById).toEqual({});
        expect(selectBrowserContextComposerAttachments(result.state)).toEqual([]);
    });
});
