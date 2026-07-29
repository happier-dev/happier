import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar context capture mapping', () => {
    it('builds screenshot context from media references without inline bytes', async () => {
        const mod = await import('./capture');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const item = mod.buildSidecarScreenshotContextItem({
            contextId: 'ctx_screenshot_1',
            sourceViewId: 'view_1',
            capturedAtMs: 1_900_000,
            navigationGeneration: 5,
            media: {
                mediaId: 'media_1',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 180_000,
            },
        });

        expect(item).toMatchObject({
            v: 1,
            contextId: 'ctx_screenshot_1',
            kind: 'browserScreenshot',
            sourceViewId: 'view_1',
            sourceAdapterKind: 'chromiumSidecar',
            fidelity: 'cdp',
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            media: {
                mediaId: 'media_1',
                mediaKind: 'image',
            },
        });
        expect(JSON.stringify(item)).not.toContain('base64');
        expect(JSON.stringify(item)).not.toContain('inlineBytes');
    });

    it('builds redacted page references for sidecar views', async () => {
        const mod = await import('./capture');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const item = mod.buildSidecarPageReferenceContextItem({
            contextId: 'ctx_page_1',
            sourceViewId: 'view_1',
            capturedAtMs: 1_900_000,
            navigationGeneration: 5,
            targetId: 'target_1',
            targetKind: 'externalUrl',
            url: 'https://example.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?project=one&token=secret',
            title: 'Dashboard',
            faviconUrl: 'https://example.test/icon/tok9f8e7d6c5b4a3210ffeeddcc.ico?cache=1&apiKey=secret',
            display: {
                title: 'Dashboard',
                addressLabel: 'example.test',
            },
        });

        expect(item).toMatchObject({
            kind: 'browserPageReference',
            sourceAdapterKind: 'chromiumSidecar',
            fidelity: 'cdp',
            redactionLevel: 'metadataOnly',
            targetId: 'target_1',
            targetKind: 'externalUrl',
            url: 'https://example.test/reset/:redacted?project',
            faviconUrl: 'https://example.test/icon/:redacted?cache',
            origin: 'https://example.test',
            title: 'Dashboard',
            display: { title: 'Dashboard' },
        });
        expect(JSON.stringify(item)).not.toContain('secret');
        expect(JSON.stringify(item)).not.toContain('tok9f8e7d6c5b4a3210ffeeddcc');
        expect(JSON.stringify(item)).not.toContain('token');
        expect(JSON.stringify(item)).not.toContain('apiKey');
    });

    it('marks attachments stale when navigation changes before send', async () => {
        const mod = await import('./capture');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const attachment = mod.buildSidecarContextAttachment({
            attachmentId: 'attachment_1',
            contextId: 'ctx_page_1',
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 5,
            currentNavigationGeneration: 6,
        });

        expect(attachment).toMatchObject({
            v: 1,
            attachmentId: 'attachment_1',
            contextId: 'ctx_page_1',
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 5,
            currentNavigationGeneration: 6,
            state: 'navigationStale',
            requiresReconfirmBeforeSend: true,
        });
    });

    it('builds explicit policy-denied context placeholders without captured content', async () => {
        const mod = await import('./capture');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const item = mod.buildSidecarContextUnavailableItem({
            contextId: 'ctx_denied_1',
            sourceViewId: 'view_1',
            kind: 'browserConsoleSummary',
            capturedAtMs: 2_100_000,
            navigationGeneration: 2,
            lifecycleState: 'policyDenied',
            disabledReason: 'browser.context disabled by policy',
        });

        expect(item).toMatchObject({
            kind: 'browserConsoleSummary',
            sourceAdapterKind: 'chromiumSidecar',
            fidelity: 'unavailable',
            lifecycleState: 'policyDenied',
            redactionLevel: 'blocked',
            summary: '',
            truncated: false,
        });
    });
});
