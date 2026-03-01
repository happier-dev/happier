import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'Binary files a/src/image.png and b/src/image.png differ',
    error: null,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionReadFile: vi.fn(),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => true,
    isKnownBinaryPath: () => true,
}));

describe('useChangedFilesReviewDiffLoading (binary placeholders)', () => {
    it('normalizes non-unified binary diff placeholders to an empty diff', async () => {
        sessionScmDiffFileSpy.mockClear();

        const file = {
            fileName: 'image.png',
            filePath: 'src',
            fullPath: 'src/image.png',
            status: 'modified',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
        } as any;

        let captured: any = null;

        function Probe() {
            const reviewFiles = React.useMemo(() => [file], []);
            const normalizeError = React.useCallback((e: unknown) => String((e as any)?.message ?? e), []);
            const hook = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles,
                diffArea: 'pending',
                tooLarge: false,
                selectedPath: 'src/image.png',
                minRefetchMs: 0,
                refreshToken: 0,
                normalizeError,
                fallbackError: 'fallback',
            });
            captured = hook.getDiffState('src/image.png');
            return React.createElement('Probe');
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        for (let i = 0; i < 30; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (captured?.status === 'loaded') break;
        }

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);
        expect(captured?.status).toBe('loaded');
        expect(String(captured?.diff ?? '')).toBe('');
    });
});
