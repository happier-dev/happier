import { describe, expect, it, vi } from 'vitest';
import type { BrowserContextCapabilities } from '@happier-dev/protocol';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { createBrowserContextAnnotationAdapter } from './annotationAdapter';
import { readBrowserAnnotationDraft, countBrowserAnnotationDraftMarks } from './annotationDraft';
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
            media: { mediaId: 'media_union_crop_1', mediaKind: 'image', width: 260, height: 110, sizeBytes: 4096 },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 260, height: 110 } },
            pageUrl: request.currentUrl,
            pageTitle: request.title,
        }),
    };
}

function buildAdapter(initial?: BrowserContextState) {
    let state = initial ?? createBrowserContextState();
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
            nowMs: () => 7_000,
        }),
        onStateChange,
    });
    return { adapter, getState: () => state };
}

describe('annotation editor overlay → draft adapter (ANNO-1)', () => {
    it('routes each editor tool to exactly one DRAFT action and gates Attach until ≥1 mark', async () => {
        const { adapter, getState } = buildAdapter();

        // Attach is disabled until ≥1 target: committing an empty draft fails closed.
        const empty = await adapter.dispatch({ kind: 'attachDraft' });
        expect(empty.status).toBe('unavailable');
        expect(countBrowserAnnotationDraftMarks(getState(), 'view_1')).toBe(0);

        // Select (element) → addDraftTarget.
        await adapter.dispatch({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#a', rect: { x: 10, y: 10, width: 20, height: 20 } },
        });
        await adapter.dispatch({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#b', rect: { x: 100, y: 50, width: 30, height: 30 } },
        });
        // Region (marquee) → addDraftRegion.
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 200, y: 80, width: 60, height: 40 } });
        // Draw (freehand) → addDraftStroke.
        await adapter.dispatch({
            kind: 'addDraftStroke',
            stroke: { shape: 'freehand', points: [{ x: 20, y: 20 }, { x: 240, y: 110 }] },
        });
        // Comment → setDraftComment.
        await adapter.dispatch({ kind: 'setDraftComment', comment: 'needs spacing' });

        const draft = readBrowserAnnotationDraft(getState(), 'view_1');
        expect(draft?.targets).toHaveLength(2);
        expect(draft?.regions).toHaveLength(1);
        expect(draft?.strokes).toHaveLength(1);
        expect(draft?.comment).toBe('needs spacing');
        expect(countBrowserAnnotationDraftMarks(getState(), 'view_1')).toBe(4);
    });

    it('Attach commits the draft into grouped context items sharing one annotationId + one media (not a fake-contextId attach*)', async () => {
        const { adapter, getState } = buildAdapter();
        await adapter.dispatch({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#a', rect: { x: 10, y: 10, width: 20, height: 20 } },
        });
        await adapter.dispatch({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#b', rect: { x: 100, y: 50, width: 30, height: 30 } },
        });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 200, y: 80, width: 60, height: 40 } });
        await adapter.dispatch({
            kind: 'addDraftStroke',
            stroke: { shape: 'freehand', points: [{ x: 20, y: 20 }, { x: 240, y: 110 }] },
        });
        await adapter.dispatch({ kind: 'setDraftComment', comment: 'needs spacing' });

        const committed = await adapter.dispatch({ kind: 'attachDraft' });
        expect(committed.status).toBe('committed');
        if (committed.status !== 'committed') return;

        const items = committed.itemIds.map((id) => getState().itemsById[id]);
        expect(items).toHaveLength(4);
        const annotationIds = new Set(items.map((i) => (i.kind === 'browserAnnotation' ? i.annotationId : 'x')));
        expect(annotationIds).toEqual(new Set([committed.annotationId]));
        const mediaIds = new Set(items.map((i) => (i.kind === 'browserAnnotation' ? i.media.mediaId : 'x')));
        expect(mediaIds).toEqual(new Set(['media_union_crop_1']));
        // Draft cleared after commit.
        expect(readBrowserAnnotationDraft(getState(), 'view_1')).toBeNull();
    });

    it('Erase removes a single draft target by id', async () => {
        const { adapter, getState } = buildAdapter();
        await adapter.dispatch({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#a', rect: { x: 10, y: 10, width: 20, height: 20 } },
        });
        await adapter.dispatch({ kind: 'addDraftRegion', rect: { x: 200, y: 80, width: 60, height: 40 } });
        const draft = readBrowserAnnotationDraft(getState(), 'view_1');
        const targetId = draft!.targets[0].draftId;
        const erased = await adapter.dispatch({ kind: 'removeDraftTarget', draftId: targetId });
        expect(erased.status).toBe('draftUpdated');
        expect(countBrowserAnnotationDraftMarks(getState(), 'view_1')).toBe(1);
    });
});
