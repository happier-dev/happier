import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '../scm.js';
import type { SessionChangeSet } from './types.js';
import { reconcileWithScmSnapshot } from './reconcileWithScmSnapshot.js';

function makeEntry(path: string): ScmWorkingEntry {
  return {
    path,
    previousPath: null,
    kind: 'modified',
    includeStatus: '.',
    pendingStatus: 'M',
    hasIncludedDelta: false,
    hasPendingDelta: true,
    stats: {
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 1,
      pendingRemoved: 0,
      isBinary: false,
    },
  };
}

function makeSnapshot(rootPath: string, entries: readonly ScmWorkingEntry[]): ScmWorkingSnapshot {
  return {
    projectKey: `project:${rootPath}`,
    fetchedAt: 1,
    repo: {
      isRepo: true,
      rootPath,
      backendId: 'git',
      mode: '.git',
      worktrees: [],
      remotes: [],
    },
    capabilities: {
      readStatus: true,
      readDiffFile: true,
      readDiffCommit: true,
      readLog: true,
      writeInclude: true,
      writeExclude: true,
      writeCommit: true,
      writeCommitPathSelection: true,
      writeCommitLineSelection: true,
      writeBackout: true,
      writeRemoteFetch: true,
      writeRemotePull: true,
      writeRemotePush: true,
      worktreeCreate: true,
      changeSetModel: 'working-copy',
      supportedDiffAreas: ['pending'],
    },
    branch: {
      head: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    },
    stashCount: 0,
    hasConflicts: false,
    entries: [...entries],
    totals: {
      includedFiles: 0,
      pendingFiles: entries.length,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 1,
      pendingRemoved: 0,
    },
  };
}

function makeChangeSet(filePath: string): SessionChangeSet {
  return {
    sessionId: 'session-1',
    turns: [],
    files: [{
      filePath,
      changeKind: 'modified',
      oldText: null,
      newText: null,
      source: 'provider_native',
      confidence: 'exact',
      provider: 'codex',
      turns: ['turn-1'],
    }],
    rolledBackTurnIds: [],
    confidenceSummary: {
      source: 'provider_native',
      confidence: 'exact',
    },
  };
}

describe('reconcileWithScmSnapshot', () => {
  it('matches provider absolute paths underneath the repository root to SCM relative paths', () => {
    const projection = reconcileWithScmSnapshot({
      sessionChangeSet: makeChangeSet('/repo/src/app.ts'),
      snapshot: makeSnapshot('/repo', [makeEntry('src/app.ts')]),
    });

    expect(projection.matchedFiles.map((file) => file.repositoryPath)).toEqual(['src/app.ts']);
    expect(projection.unmatchedSessionFiles).toEqual([]);
  });

  it('does not treat sibling absolute paths as inside the repository root', () => {
    const projection = reconcileWithScmSnapshot({
      sessionChangeSet: makeChangeSet('/repo-other/src/app.ts'),
      snapshot: makeSnapshot('/repo', [makeEntry('src/app.ts')]),
    });

    expect(projection.matchedFiles).toEqual([]);
    expect(projection.unmatchedSessionFiles.map((file) => file.filePath)).toEqual(['/repo-other/src/app.ts']);
  });

  it('matches Windows provider absolute paths underneath the repository root', () => {
    const projection = reconcileWithScmSnapshot({
      sessionChangeSet: makeChangeSet('C:\\Users\\Alice\\repo\\src\\app.ts'),
      snapshot: makeSnapshot('c:\\users\\alice\\repo', [makeEntry('src/app.ts')]),
    });

    expect(projection.matchedFiles.map((file) => file.repositoryPath)).toEqual(['src/app.ts']);
    expect(projection.unmatchedSessionFiles).toEqual([]);
  });
});
