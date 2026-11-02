import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createBrowserContextState } from '@/sync/domains/browser/context/state';
import { startBrowserAnnotationDraft } from '@/sync/domains/browser/context/annotationDraft';
import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { useBrowserAnnotationController } from './useBrowserAnnotationController';

afterEach(standardCleanup);
const capabilities: BrowserContextCapabilities = { enabled: true, available: true,
    supportedContextKinds: ['browserAnnotation'], supportedAdapterKinds: ['externalUrl'],
    screenshot: { supported: true, requiresAttachmentUploads: true },
    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 }, disabledReasons: [], policyDeniedReasons: [] };
const view: BrowserControlViewState = {
    browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 3,
    target: { kind: 'externalUrl', targetId: 'shop', url: 'https://shop.example/' },
    platform: 'web', adapterKind: 'externalUrl', engineKind: 'desktopWebView',
    adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['desktopWebView'] }),
    currentUrl: 'https://shop.example/', currentUrlExpiresAt: null, pendingUrl: null, title: 'Shop', faviconUrl: null,
    loadingState: 'ready', loadingProgress: 1, canGoBack: false, canGoForward: false,
    securityOrigin: 'https://shop.example', lastError: null, openerViewId: null,
    adapterRefreshStatus: 'idle', adapterRefreshError: null,
};

describe('browser annotation frozen host projection', () => {
    it('edits the shared document, records facts without adding marks, and queries the frozen generation', async () => {
        const query = vi.fn(async () => null); // Diagnostics transport boundary.
        const publications = vi.fn();
        const initial = startBrowserAnnotationDraft(createBrowserContextState(), { ...view, navigationGeneration: 2,
            nowMs: 1, source: { uri: 'data:image/png;base64,fixture', width: 800, height: 600, scale: 2 },
            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 800, height: 600, sizeBytes: 1 } });
        const hook = await renderHook(() => {
            const [state, setState] = React.useState(initial);
            return useBrowserAnnotationController({ activeView: view, activeViewNavigationKey: 'view_1:3',
                browserContext: { state, contextCapabilities: capabilities,
                    onStateChange: next => { publications(next); setState(next); }, queryElementAtPoint: query } });
        });
        publications.mockClear();
        const document = { ...hook.getCurrent()!.draft!.document, marks: [{ id: 'element_1', kind: 'element' as const,
            color: 'blue' as const, label: 'Pay', rect: { x: 10, y: 20, width: 30, height: 40 } }] };
        await act(async () => {
            hook.getCurrent()!.recordElement('element_1', { rect: document.marks[0].rect, label: 'Pay', selectorPath: '#pay' });
        });
        await act(async () => {
            hook.getCurrent()!.changeDocument(document);
        });
        expect(publications).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()!.draft!.document).toBe(document);
        expect(hook.getCurrent()!.draft!.document.marks).toHaveLength(1);
        expect(hook.getCurrent()!.draft!.elements.element_1).toEqual({ selectorPath: '#pay' });
        await hook.getCurrent()!.queryElementAtPoint!({ x: 20, y: 30 });
        expect(query).toHaveBeenCalledWith({ x: 20, y: 30 }, 2);
    });
});
