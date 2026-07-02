import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { renderScreen } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'unexpected',
    error: null,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceReadFile: vi.fn(),
}));

function file(fullPath: string): ScmFileStatus {
    return {
        fileName: fullPath.split('/').pop() ?? fullPath,
        filePath: fullPath.split('/').slice(0, -1).join('/'),
        fullPath,
        status: 'modified',
        isIncluded: false,
        linesAdded: 1,
        linesRemoved: 1,
    };
}

type DiffStateSource = ReturnType<typeof useChangedFilesReviewDiffLoading>['diffStateSource'];

describe('useChangedFilesReviewDiffLoading (provider diffs)', () => {
    it('uses provider-backed diffs without fetching SCM diffs', async () => {
        sessionScmDiffFileSpy.mockClear();

        const reviewFile = file('src/a.ts');

        const capturedDiffStateSource: { current: DiffStateSource | null } = { current: null };

        function Probe() {
            const reviewFiles = React.useMemo(() => [reviewFile], []);
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
            capturedDiffStateSource.current = hook.diffStateSource;
            return React.createElement('Probe');
        }

        await renderScreen(React.createElement(Probe));

        const finalState = capturedDiffStateSource.current?.getDiffState('src/a.ts');
        expect(sessionScmDiffFileSpy).not.toHaveBeenCalled();
        expect(finalState?.status).toBe('loaded');
        expect(String(finalState?.diff ?? '')).toContain('diff --git a/src/a.ts b/src/a.ts');
    });

    it('hydrates provider-backed diffs only for requested paths', async () => {
        sessionScmDiffFileSpy.mockClear();

        const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(file);

        const capturedDiffStateSource: { current: DiffStateSource | null } = { current: null };

        function Probe() {
            const providerDiffByPath = React.useMemo(() => new Map([
                ['src/a.ts', 'provider-a'],
                ['src/b.ts', 'provider-b'],
                ['src/c.ts', 'provider-c'],
            ]), []);
            const hook = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles: files,
                diffArea: 'pending',
                requestedPaths: ['src/b.ts'],
                tooLarge: false,
                selectedPath: '',
                minRefetchMs: 0,
                refreshToken: 0,
                providerDiffByPath,
                normalizeError: (value) => String(value),
                fallbackError: 'fallback',
            });
            capturedDiffStateSource.current = hook.diffStateSource;
            return React.createElement('Probe');
        }

        await renderScreen(React.createElement(Probe));

        expect(sessionScmDiffFileSpy).not.toHaveBeenCalled();
        expect(capturedDiffStateSource.current?.getDiffState('src/a.ts')?.status).toBe('idle');
        expect(capturedDiffStateSource.current?.getDiffState('src/b.ts')).toEqual({
            status: 'loaded',
            diff: 'provider-b',
            error: null,
        });
        expect(capturedDiffStateSource.current?.getDiffState('src/c.ts')?.status).toBe('idle');
    });
});
