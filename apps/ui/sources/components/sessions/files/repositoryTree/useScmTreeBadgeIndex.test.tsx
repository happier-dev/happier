import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useScmTreeBadgeIndex } from './useScmTreeBadgeIndex';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

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

function Harness(props: Readonly<{ snapshot: any | null }>) {
    const index = useScmTreeBadgeIndex(props.snapshot);
    const badge = index?.getFileBadge('src/a.ts') ?? null;
    return React.createElement('Text', { value: badge ? `${badge.kindLetter}:${badge.added}:${badge.removed}` : 'none' });
}

describe('useScmTreeBadgeIndex', () => {
    it('defers index computation on web for progressive rendering', async () => {
        vi.useFakeTimers();
        const snapshot = makeSnapshot();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Harness snapshot={snapshot} />);
        });

        expect(tree.root.findByType('Text').props.value).toBe('none');

        await act(async () => {
            vi.runAllTimers();
        });

        expect(tree.root.findByType('Text').props.value).toBe('M:2:1');

        vi.useRealTimers();
    });
});
