import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar context publication boundary', () => {
    it('publishes page context only for the owning account and keeps raw URLs redacted', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        const denied = publisher.publishPageReference({
            requesterAccountId: 'account_other',
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
            contextId: 'ctx_page_1',
            sourceViewId: 'view_1',
            capturedAtMs: 10_000,
            navigationGeneration: 3,
            url: 'https://example.test/dashboard?token=secret&project=one',
            title: 'Dashboard',
        });

        expect(denied).toEqual({
            status: 'denied',
            reason: 'not_owner',
            published: false,
        });
        expect(published).toEqual([]);

        const allowed = publisher.publishPageReference({
            requesterAccountId: 'account_owner',
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
            contextId: 'ctx_page_1',
            sourceViewId: 'view_1',
            capturedAtMs: 10_000,
            navigationGeneration: 3,
            url: 'https://example.test/dashboard?token=secret&project=one',
            title: 'Dashboard',
        });

        expect(allowed).toMatchObject({ status: 'published', published: true });
        expect(published).toHaveLength(1);
        expect(JSON.stringify(published)).toContain('https://example.test/dashboard?project');
        expect(JSON.stringify(published)).not.toContain('token');
        expect(JSON.stringify(published)).not.toContain('secret');
    });

    it('publishes explicit policy or runtime unavailable context placeholders without captured content', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        const base = {
            requesterAccountId: 'account_owner',
            contextId: 'ctx_summary_1',
            sourceViewId: 'view_1',
            capturedAtMs: 20_000,
            navigationGeneration: 3,
            kind: 'browserConsoleSummary' as const,
        };

        expect(publisher.publishUnavailable({ ...base, featureEnabled: false, policyAllowed: true, runtimeAvailable: true }))
            .toMatchObject({ status: 'published', lifecycleState: 'policyDenied' });
        expect(publisher.publishUnavailable({ ...base, contextId: 'ctx_summary_2', featureEnabled: true, policyAllowed: false, runtimeAvailable: true }))
            .toMatchObject({ status: 'published', lifecycleState: 'policyDenied' });
        expect(publisher.publishUnavailable({ ...base, contextId: 'ctx_summary_3', featureEnabled: true, policyAllowed: true, runtimeAvailable: false }))
            .toMatchObject({ status: 'published', lifecycleState: 'adapterUnavailable' });

        expect(published).toHaveLength(3);
        expect(published.map((item) => (item as { lifecycleState: string }).lifecycleState)).toEqual([
            'policyDenied',
            'policyDenied',
            'adapterUnavailable',
        ]);
        expect(JSON.stringify(published)).not.toContain('base64');
        expect(JSON.stringify(published)).not.toContain('inlineBytes');
    });

    it('publishes screenshot context as media references only and rejects stale attachments before send', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        const result = publisher.publishScreenshotReference({
            requesterAccountId: 'account_owner',
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
            contextId: 'ctx_screenshot_1',
            sourceViewId: 'view_1',
            capturedAtMs: 30_000,
            navigationGeneration: 4,
            media: {
                mediaId: 'media_1',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 200_000,
            },
        });

        expect(result).toMatchObject({ status: 'published', published: true });
        expect(published).toHaveLength(1);
        expect(JSON.stringify(published)).toContain('media_1');
        expect(JSON.stringify(published)).not.toContain('base64');
        expect(JSON.stringify(published)).not.toContain('inlineBytes');

        expect(publisher.resolveAttachmentForSend({
            attachmentId: 'attachment_1',
            contextId: 'ctx_screenshot_1',
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 4,
            currentNavigationGeneration: 5,
        })).toMatchObject({
            status: 'blocked',
            reason: 'navigation_stale',
            attachment: {
                state: 'navigationStale',
                requiresReconfirmBeforeSend: true,
            },
        });
    });

    it('blocks unavailable screenshot publication without emitting a misleading non-screenshot item', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        expect(publisher.publishScreenshotReference({
            requesterAccountId: 'account_owner',
            featureEnabled: false,
            policyAllowed: true,
            runtimeAvailable: true,
            contextId: 'ctx_screenshot_blocked',
            sourceViewId: 'view_1',
            capturedAtMs: 40_000,
            navigationGeneration: 4,
            media: {
                mediaId: 'media_unavailable',
                mediaKind: 'image',
                width: 1,
                height: 1,
                sizeBytes: 1,
            },
        })).toMatchObject({
            status: 'blocked',
            reason: 'policy_denied',
            lifecycleState: 'policyDenied',
            published: false,
        });
        expect(published).toEqual([]);
    });

    it('preserves runtime and privacy lifecycle states for unavailable context placeholders', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        const base = {
            requesterAccountId: 'account_owner',
            contextId: 'ctx_summary_sensitive',
            sourceViewId: 'view_1',
            capturedAtMs: 50_000,
            navigationGeneration: 5,
            kind: 'browserNetworkSummary' as const,
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
        };

        expect(publisher.publishUnavailable({
            ...base,
            lifecycleState: 'sensitiveOrigin',
            disabledReason: 'browser context blocked for sensitive origin',
        })).toMatchObject({ status: 'published', lifecycleState: 'sensitiveOrigin' });
        expect(publisher.publishUnavailable({
            ...base,
            contextId: 'ctx_summary_failed',
            lifecycleState: 'captureFailed',
            disabledReason: 'browser context capture failed',
        })).toMatchObject({ status: 'published', lifecycleState: 'captureFailed' });

        expect(published.map((item) => (item as { lifecycleState: string }).lifecycleState)).toEqual([
            'sensitiveOrigin',
            'captureFailed',
        ]);
        expect(JSON.stringify(published)).not.toContain('media_');
        expect(JSON.stringify(published)).not.toContain('inlineBytes');
    });

    it('blocks screenshot publication with the explicit sensitive lifecycle state', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarContextPublisher({
            publish: (item) => published.push(item),
            ownerAccountId: 'account_owner',
        });

        expect(publisher.publishScreenshotReference({
            requesterAccountId: 'account_owner',
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
            lifecycleState: 'sensitiveOrigin',
            disabledReason: 'browser screenshot blocked for sensitive origin',
            contextId: 'ctx_screenshot_sensitive',
            sourceViewId: 'view_1',
            capturedAtMs: 60_000,
            navigationGeneration: 6,
            media: {
                mediaId: 'media_should_not_publish',
                mediaKind: 'image',
                width: 1,
                height: 1,
                sizeBytes: 1,
            },
        })).toMatchObject({
            status: 'blocked',
            reason: 'policy_denied',
            lifecycleState: 'sensitiveOrigin',
            published: false,
        });
        expect(published).toEqual([]);
    });
});
