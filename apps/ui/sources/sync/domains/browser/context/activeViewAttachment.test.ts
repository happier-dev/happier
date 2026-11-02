import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
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
