import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'unexpected',
    error: null,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionReadFile: vi.fn(),
}));

describe('useChangedFilesReviewDiffLoading (provider diffs)', () => {
    it('uses provider-backed diffs without fetching SCM diffs', async () => {
        sessionScmDiffFileSpy.mockClear();

        const file = {
            fileName: 'a.ts',
            filePath: 'src',
            fullPath: 'src/a.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 1,
        } as any;

        let diffStateSource: any = null;

        function Probe() {
            const reviewFiles = React.useMemo(() => [file], []);
            const providerDiffByPath = React.useMemo(() => new Map([
                ['src/a.ts', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'],
            ]), []);
            const hook = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles,
                diffArea: 'pending',
                tooLarge: false,
                selectedPath: 'src/a.ts',
                minRefetchMs: 0,
                refreshToken: 0,
                providerDiffByPath,
                normalizeError: (value) => String(value),
                fallbackError: 'fallback',
            });
            diffStateSource = hook.diffStateSource;
            return React.createElement('Probe');
        }

        await renderScreen(React.createElement(Probe));

        const finalState = diffStateSource?.getDiffState?.('src/a.ts');
        expect(sessionScmDiffFileSpy).not.toHaveBeenCalled();
        expect(finalState?.status).toBe('loaded');
        expect(String(finalState?.diff ?? '')).toContain('diff --git a/src/a.ts b/src/a.ts');
    });
});
