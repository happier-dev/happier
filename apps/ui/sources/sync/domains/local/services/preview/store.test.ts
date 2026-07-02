import { describe, expect, it } from 'vitest';

import type { BrowserViewTargetV1, LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

type PreviewStoreModule = typeof import('./store');

async function loadPreviewStoreModule(): Promise<PreviewStoreModule | null> {
    return import('./store').catch(() => null);
}

function createPreviewResource(overrides: Partial<LocalServicePreviewResourceV1> = {}): LocalServicePreviewResourceV1 {
    return {
        previewId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/dashboard', search: '?tab=preview' },
        display: {
            title: 'Dashboard',
            addressLabel: 'localhost:5173',
            folderLabel: 'web',
            iconToken: 'browser',
        },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: {
                title: 'Dashboard',
                addressLabel: 'localhost:5173',
            },
        },
        ...overrides,
    };
}

describe('local service preview store', () => {
    it('stores registered preview access metadata and resolves it from a browser target', async () => {
        const mod = await loadPreviewStoreModule();

        expect(mod?.createLocalServicePreviewState).toBeTypeOf('function');
        if (!mod) return;

        const resource = createPreviewResource();
        const state = mod.applyLocalServicePreviewSnapshot(mod.createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: resource.previewId,
                resource,
                accessUrl: 'https://preview-1.preview.happier.test/dashboard?tab=preview&previewToken=token_1',
                expiresAt: 2_000,
                diagnostics: [],
            }],
            diagnostics: [],
        });

        const selected = mod.selectLocalServicePreviewByBrowserTarget(state, resource.browserTarget as BrowserViewTargetV1);

        expect(selected).toMatchObject({
            previewId: 'preview_1',
            accessUrl: 'https://preview-1.preview.happier.test/dashboard?tab=preview&previewToken=token_1',
            expiresAt: 2_000,
        });
    });

    it('keeps registered previews visible while refresh is in flight', async () => {
        const mod = await loadPreviewStoreModule();

        expect(mod?.applyLocalServicePreviewRefreshStarted).toBeTypeOf('function');
        if (!mod) return;

        const resource = createPreviewResource();
        const hydrated = mod.applyLocalServicePreviewSnapshot(mod.createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: resource.previewId,
                resource,
                accessUrl: 'https://preview-1.preview.happier.test/',
                expiresAt: 2_000,
                diagnostics: [],
            }],
            diagnostics: [],
        });

        const refreshing = mod.applyLocalServicePreviewRefreshStarted(hydrated, 1_500);

        expect(mod.selectLocalServicePreviewRows(refreshing)).toHaveLength(1);
        expect(refreshing.refreshState).toBe('refreshing');
    });
});
