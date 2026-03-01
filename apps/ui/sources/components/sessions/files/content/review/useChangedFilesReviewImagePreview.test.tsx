import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'filesImagePreviewCacheMaxEntries') return 10;
        if (key === 'filesImagePreviewCacheMaxTotalBytes') return 1_000_000;
        if (key === 'filesImagePreviewMaxBytes') return 1_000_000;
        return undefined;
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionReadFile: vi.fn(async () => ({ success: true, content: 'YWJj' })), // "abc" base64
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(count = 3): Promise<void> {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useChangedFilesReviewImagePreview', () => {
    it('caches loaded previews by session+signature+path to avoid redundant reads', async () => {
        const { sessionReadFile } = await import('@/sync/ops');
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
        await act(async () => {
            tree = renderer.create(<Test enabled={true} />);
            await flushAsync(8);
        });

        expect(vi.mocked(sessionReadFile)).toHaveBeenCalledTimes(1);
        expect(current.status).toBe('loaded');

        await act(async () => {
            tree!.update(<Test enabled={true} />);
            await flushAsync(4);
        });

        expect(vi.mocked(sessionReadFile)).toHaveBeenCalledTimes(1);
        expect(current.status).toBe('loaded');
        await act(async () => {
            tree!.unmount();
        });
    });
});
