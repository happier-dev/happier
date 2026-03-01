import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({ success: true, diff: '', error: null }));
const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: Buffer.from('hello\nworld\n').toString('base64'),
    error: null,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionReadFile: (...args: any[]) => sessionReadFileSpy(...args),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

describe('useChangedFilesReviewDiffLoading (fallback diff)', () => {
    it('synthesizes a diff for untracked files when SCM diff returns empty', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionReadFileSpy.mockClear();

        const file = {
            fileName: 'new.txt',
            filePath: 'src',
            fullPath: 'src/new.txt',
            status: 'untracked',
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
                selectedPath: 'src/new.txt',
                minRefetchMs: 0,
                refreshToken: 0,
                normalizeError,
                fallbackError: 'fallback',
            });
            captured = hook.getDiffState('src/new.txt');
            return React.createElement('Probe');
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        for (let i = 0; i < 30; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (typeof captured?.diff === 'string' && captured.diff.includes('diff --git')) break;
        }

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);
        expect(sessionReadFileSpy).toHaveBeenCalledTimes(1);
        expect(String(captured?.diff ?? '')).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(String(captured?.diff ?? '')).toContain('+hello');
        expect(String(captured?.diff ?? '')).toContain('+world');
    });
});
