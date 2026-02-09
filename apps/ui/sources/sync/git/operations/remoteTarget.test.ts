import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '@happier-dev/protocol';

import { inferRemoteTargetFromSnapshot } from './remoteTarget';

function makeSnapshot(partial?: Partial<GitWorkingSnapshot['branch']>): GitWorkingSnapshot {
    return {
        projectKey: 'p',
        fetchedAt: 1,
        repo: {
            isGitRepo: true,
            rootPath: '/repo',
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
            ...(partial ?? {}),
        },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            stagedFiles: 0,
            unstagedFiles: 0,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
        },
    };
}

describe('inferRemoteTargetFromSnapshot', () => {
    it('uses parsed upstream when available', () => {
        expect(inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: 'upstream/feature/x' }))).toEqual({
            remote: 'upstream',
            branch: 'feature/x',
        });
    });

    it('falls back to origin + head when upstream is missing', () => {
        expect(inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: null, head: 'release/1.2' }))).toEqual({
            remote: 'origin',
            branch: 'release/1.2',
        });
    });

    it('returns null branch on detached head without upstream', () => {
        expect(
            inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: null, head: null, detached: true }))
        ).toEqual({
            remote: 'origin',
            branch: null,
        });
    });
});

