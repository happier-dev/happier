import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android,
            },
        });
    },
});

function makeSnapshot() {
    return {
        projectKey: 'p1',
        fetchedAt: 0,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: false,
            writeCommitLineSelection: false,
            writeBackout: false,
            writeRemoteFetch: false,
            writeRemotePull: false,
            writeRemotePush: false,
            worktreeCreate: false,
            changeSetModel: 'index',
            supportedDiffAreas: ['pending'],
        },
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 2,
            pendingRemoved: 1,
        },
    } as any;
}

describe('useScmTreeBadgeIndex (native)', () => {
    it('computes the badge index during render', async () => {
        const { useScmTreeBadgeIndex } = await import('./useScmTreeBadgeIndex');
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        function Harness() {
            const index = useScmTreeBadgeIndex(makeSnapshot());
            const badge = index?.getFileBadge('src/a.ts') ?? null;
            return React.createElement('Text', { value: badge ? `${badge.kindLetter}:${badge.added}:${badge.removed}` : 'none' });
        }

        try {
            const screen = await renderScreen(<Harness />);

            expect(screen.tree.root.findByType('Text').props.value).toBe('M:2:1');
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
