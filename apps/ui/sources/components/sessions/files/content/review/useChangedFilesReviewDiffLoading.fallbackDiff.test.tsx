import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '../filesContentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFilesContentCommonModuleMocks();

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

        let diffStateSource: any = null;

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
            diffStateSource = hook.diffStateSource;
            return React.createElement('Probe');
        }

        await renderScreen(React.createElement(Probe));

        for (let i = 0; i < 30; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
            const current = diffStateSource?.getDiffState?.('src/new.txt');
            if (typeof current?.diff === 'string' && current.diff.includes('diff --git')) break;
        }

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);
        expect(sessionReadFileSpy).toHaveBeenCalledTimes(1);
        const finalState = diffStateSource?.getDiffState?.('src/new.txt');
        expect(String(finalState?.diff ?? '')).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(String(finalState?.diff ?? '')).toContain('+hello');
        expect(String(finalState?.diff ?? '')).toContain('+world');
    });
});
