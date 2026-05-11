import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';

const createSessionFilePreviewSourceSpy = vi.hoisted(() => vi.fn());

installFilesContentCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'filesImagePreviewCacheMaxEntries') return 10;
                if (key === 'filesImagePreviewCacheMaxTotalBytes') return 1_000_000;
                if (key === 'filesImagePreviewMaxBytes') return 1_000_000;
                return undefined;
            },
        });
    },
});

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
}));

vi.mock('@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource', () => ({
    createSessionFilePreviewSource: (...args: unknown[]) => createSessionFilePreviewSourceSpy(...args),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useChangedFilesReviewImagePreview', () => {
    it('caches loaded previews by session+signature+path to avoid redundant reads', async () => {
        createSessionFilePreviewSourceSpy.mockResolvedValue({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:preview',
                byteLength: 3,
                mimeType: 'image/png',
                svgXml: null,
                revoke: vi.fn(),
            },
        });
        const { useChangedFilesReviewImagePreview } = await import('./useChangedFilesReviewImagePreview');

        let current: any = null;
        function Test(props: { enabled: boolean }) {
            current = useChangedFilesReviewImagePreview({
                sessionId: 's1',
                snapshotSignature: 'sig1',
                filePath: 'image.png',
                enabled: props.enabled,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Test enabled={true} />)).tree;

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(1);
        expect(current.status).toBe('loaded');

        act(() => {
            tree!.update(<Test enabled={true} />);
        });

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(1);
        expect(current.status).toBe('loaded');
        act(() => {
            tree!.unmount();
        });
    });

    it('supports svg previews (including decoded svgXml for native rendering)', async () => {
        const { useChangedFilesReviewImagePreview } = await import('./useChangedFilesReviewImagePreview');

        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        createSessionFilePreviewSourceSpy.mockResolvedValueOnce({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:svg-preview',
                byteLength: svg.length,
                mimeType: 'image/svg+xml',
                svgXml: svg,
                revoke: vi.fn(),
            },
        });

        let current: any = null;
        function Test(props: { enabled: boolean }) {
            current = useChangedFilesReviewImagePreview({
                sessionId: 's1',
                snapshotSignature: 'sig1',
                filePath: 'image.svg',
                enabled: props.enabled,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Test enabled={true} />)).tree;

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(1);
        expect(current.status).toBe('loaded');
        expect(current.uri).toBe('blob:svg-preview');
        expect(current.svgXml).toBe(svg);

        act(() => {
            tree!.unmount();
        });
    });
});
