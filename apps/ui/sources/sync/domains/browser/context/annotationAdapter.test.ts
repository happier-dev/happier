import { describe, expect, it, vi } from 'vitest';
import { type BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { createBrowserContextAnnotationAdapter } from './annotationAdapter';
import { createBrowserContextState } from './state';
import type { BrowserContextState } from './types';
import { readFrozenBrowserAnnotationDraft } from './annotationDraft';
import { createDeferred } from '@/dev/testkit';
import { BrowserDiagnosticsElementPickerResultV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';

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

describe('browser context annotation adapter', () => {
    it('attaches one supplied diagnostic element through the selected-element owner and rejects stale picker results', async () => {
        let state = createBrowserContextState();
        const base = buildView();
        const view: BrowserControlViewState = { ...base, adapterCapabilities: { ...base.adapterCapabilities, contextKinds: ['browserSelectedElement'] } };
        const publish = vi.fn((next: BrowserContextState) => { state = next; });
        const adapter = createBrowserContextAnnotationAdapter({ resolveBinding: () => ({ state, view,
            browserContextEnabled: true, browserDiagnosticsEnabled: true,
            contextCapabilities: { ...annotationCapabilities, supportedContextKinds: ['browserSelectedElement'] },
        }), onStateChange: publish });
        const selected = BrowserDiagnosticsElementPickerResultV1Schema.parse({ v: 1, pickerRequestId: 'pick_1',
            viewId: view.viewId, navigationGeneration: view.navigationGeneration, tier: 'injectedPage',
            status: 'selected', audited: true, selectorPath: '#submit', accessibleName: 'Submit' });
        expect(await adapter.captureSelectedElement?.({ ...selected, navigationGeneration: 0 })).toMatchObject({ status: 'unavailable' });
        expect(publish).not.toHaveBeenCalled();
        expect(await adapter.captureSelectedElement?.(selected)).toMatchObject({ status: 'captured' });
        expect(publish).toHaveBeenCalledTimes(1);
        expect(state.attachmentOrder).toHaveLength(1);
        expect(state.itemsById[state.itemOrder[0]!]).toMatchObject({ kind: 'browserSelectedElement', selectorPath: '#submit', accessibleName: 'Submit' });
    });
    it('freezes exactly one viewport at start and disposes it on cancel without uploading original pixels', async () => {
        let state = createBrowserContextState();
        const view = buildView();
        const dispose = vi.fn();
        const captureViewport = vi.fn(async () => ({ status: 'captured' as const,
            source: { uri: 'blob:viewport', width: 40, height: 30, scale: 1 },
            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 1 }, dispose,
        }));
        const provider = { available: true, captureViewport };
        const adapter = createBrowserContextAnnotationAdapter({ resolveBinding: () => ({ state, view,
            browserContextEnabled: true, attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities,
            captureProvider: provider, commitAnnotation: async () => ({ ok: false as const, reason: 'not_attached' }),
        }), onStateChange: next => { state = next; } });
        expect(await adapter.dispatch({ kind: 'start' })).toMatchObject({ status: 'started' });
        expect(readFrozenBrowserAnnotationDraft(state, view.viewId)?.source.uri).toBe('blob:viewport');
        expect(await adapter.dispatch({ kind: 'start' })).toMatchObject({ status: 'started' });
        expect(captureViewport).toHaveBeenCalledTimes(1);
        expect(await adapter.dispatch({ kind: 'cancel' })).toMatchObject({ status: 'cancelled' });
        expect(readFrozenBrowserAnnotationDraft(state, view.viewId)).toBeNull();
        expect(dispose).toHaveBeenCalledTimes(1);
    });
    it('shares the one admitted viewport capture across concurrent starts and releases a cancelled result', async () => {
        let state = createBrowserContextState();
        const view = buildView();
        const captured = createDeferred<void>();
        const dispose = vi.fn();
        const captureViewport = vi.fn(async () => {
            await captured.promise;
            return { status: 'captured' as const, source: { uri: 'blob:pending', width: 40, height: 30, scale: 1 },
                capture: { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 1 }, dispose };
        });
        const adapter = createBrowserContextAnnotationAdapter({ resolveBinding: () => ({ state, view,
            browserContextEnabled: true, attachmentsUploadsEnabled: true, contextCapabilities: annotationCapabilities,
            captureProvider: { available: true, captureViewport }, commitAnnotation: async () => ({ ok: false as const, reason: 'not_attached' }),
        }), onStateChange: next => { state = next; } });
        const first = adapter.dispatch({ kind: 'start' });
        const second = adapter.dispatch({ kind: 'start' });
        await adapter.dispatch({ kind: 'cancel' });
        captured.resolve();
        expect(await first).toMatchObject({ status: 'unavailable' });
        expect(await second).toMatchObject({ status: 'unavailable' });
        expect(captureViewport).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(readFrozenBrowserAnnotationDraft(state, view.viewId)).toBeNull();
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
