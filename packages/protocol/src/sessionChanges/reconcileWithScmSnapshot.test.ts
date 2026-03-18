import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '../scm.js';
import type { SessionChangeSet } from './types.js';
import { reconcileWithScmSnapshot } from './reconcileWithScmSnapshot.js';

const snapshot: ScmWorkingSnapshot = {
    projectKey: 'project_1',
    fetchedAt: 1_700_000_000_000,
    repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
    },
    capabilities: {
        readStatus: true,
        readDiffFile: true,
        readDiffCommit: true,
        readLog: true,
        writeInclude: true,
        writeExclude: true,
        writeDiscard: true,
        writeCommit: true,
        writeCommitPathSelection: true,
        writeCommitLineSelection: true,
        writeBackout: true,
        writeRemoteFetch: true,
        writeRemotePull: true,
        writeRemotePush: true,
        workspaceWorktreeCreate: true,
        changeSetModel: 'working-copy',
        supportedDiffAreas: ['included', 'pending', 'both'],
    },
    branch: {
        head: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        detached: false,
    },
    hasConflicts: false,
    entries: [
        {
            path: 'src/app.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: 'M',
            pendingStatus: 'M',
            hasIncludedDelta: true,
            hasPendingDelta: true,
            stats: {
                includedAdded: 2,
                includedRemoved: 1,
                pendingAdded: 2,
                pendingRemoved: 1,
                isBinary: false,
            },
        },
        {
            path: 'src/repo-only.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: 'M',
            pendingStatus: 'M',
            hasIncludedDelta: true,
            hasPendingDelta: true,
            stats: {
                includedAdded: 1,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 0,
                isBinary: false,
            },
        },
    ],
    totals: {
        includedFiles: 2,
        pendingFiles: 2,
        untrackedFiles: 0,
        includedAdded: 3,
        includedRemoved: 1,
        pendingAdded: 3,
        pendingRemoved: 1,
    },
};

const sessionChangeSet: SessionChangeSet = {
    sessionId: 'session_1',
    turns: [],
    files: [
        {
            filePath: 'src/app.ts',
            changeKind: 'modified',
            oldText: 'a\n',
            newText: 'b\n',
            source: 'provider_native',
            confidence: 'exact',
            provider: 'codex',
            turns: ['turn_1'],
        },
        {
            filePath: 'src/session-only.ts',
            changeKind: 'added',
            newText: 'hello\n',
            source: 'provider_native',
            confidence: 'exact',
            provider: 'codex',
            turns: ['turn_2'],
        },
    ],
    rolledBackTurnIds: [],
    confidenceSummary: {
        source: 'provider_native',
        confidence: 'exact',
    },
};

describe('reconcileWithScmSnapshot', () => {
    it('projects session changes onto the current working tree and keeps repository-only files separate', () => {
        const projection = reconcileWithScmSnapshot({
            sessionChangeSet,
            snapshot,
        });

        expect(projection.matchedFiles).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                repositoryPath: 'src/app.ts',
            }),
        ]);
        expect(projection.unmatchedSessionFiles).toEqual([
            expect.objectContaining({
                filePath: 'src/session-only.ts',
            }),
        ]);
        expect(projection.repositoryOnlyFiles).toEqual([
            expect.objectContaining({
                path: 'src/repo-only.ts',
            }),
        ]);
        expect(projection.projectionReliability).toEqual('exact');
    });
});
