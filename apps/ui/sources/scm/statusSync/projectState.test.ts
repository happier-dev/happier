import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildScmDiffSnapshotSignature, buildScmFileDiffSnapshotSignature } from '../diffCache/scmDiffCacheKey';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getCachedRepositoryDirectoryEntries, setCachedRepositoryDirectoryEntries } from '@/sync/domains/input/repositoryDirectory';
import { registerSuggestionFileSearchCacheClearer } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import { storage } from '@/sync/domains/state/storage';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildSnapshotSignature, clearSearchCacheForProject, getRepoScopeSessionIds } from './projectState';

vi.mock('@/sync/domains/input/suggestionFile', () => {
    throw new Error('projectState must not load the full file-search suggestion module when clearing caches');
});

const initialState = storage.getState();
afterEach(() => {
    storage.setState(initialState, true);
});

// The real store and project registry read these sessions; metadata stays as partial as the scenario needs.
function sessionsState(sessions: Record<string, Partial<Session>>): Record<string, Session> {
    return Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, createSessionFixture({ id, ...session })]));
}
function metadata(value: Record<string, unknown>): Session['metadata'] {
    return value as Session['metadata'];
}

function makeSnapshot(
  partial: Partial<ScmWorkingSnapshot> & Pick<ScmWorkingSnapshot, 'repo'>
): ScmWorkingSnapshot {
  return {
    projectKey: 'local:/repo',
    fetchedAt: 1,
    branch: {
      head: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: {
      includedFiles: 0,
      pendingFiles: 0,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 0,
      pendingRemoved: 0,
    },
    ...partial,
  };
}

describe('buildSnapshotSignature', () => {
  it('projects a file revision without visiting unrelated changes, retaining repository and refresh invalidation', () => {
    const entry: ScmWorkingSnapshot['entries'][number] = {
      path: 'asset.png', previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
      hasIncludedDelta: false, hasPendingDelta: true,
      stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: true },
    };
    let unrelatedPathReads = 0;
    const unrelated = Array.from({ length: 54_849 }, (_, index) => ({ ...entry,
      get path() { unrelatedPathReads++; return `unrelated/${index}.txt`; },
    }));
    const base = makeSnapshot({ repo: { isRepo: true, rootPath: '/repo' }, entries: [entry, ...unrelated] });
    const signature = buildScmFileDiffSnapshotSignature(base, entry);
    expect(unrelatedPathReads).toBe(0);
    expect(signature).toBe(buildScmDiffSnapshotSignature({ ...base, entries: [entry] }));
    for (const changed of [
      { ...base, fetchedAt: 2 },
      { ...base, repo: { ...base.repo, defaultBranch: 'release' } },
      { ...base, branch: { ...base.branch, headOid: 'new-head' } },
      { ...base, operationState: { kind: 'merge' as const, sourceRef: 'main', canContinue: true, canAbort: true } },
    ]) expect(buildScmFileDiffSnapshotSignature(changed, entry)).not.toBe(signature);
    expect(buildScmFileDiffSnapshotSignature(base, { ...entry, stats: { ...entry.stats, pendingAdded: 2 } })).not.toBe(signature);
    expect(buildScmFileDiffSnapshotSignature(base, null)).not.toBe(signature);
    expect(unrelatedPathReads).toBe(0);
    // Whole-review invalidation still covers every changed file.
    expect(buildScmDiffSnapshotSignature(base)).not.toBe(buildScmDiffSnapshotSignature({ ...base, entries: [entry] }));
  });

  it('keeps diff acquisition fresh when status shape is unchanged', () => {
    const base = makeSnapshot({ repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] } });
    expect(buildScmDiffSnapshotSignature({ ...base, fetchedAt: 1 })).not.toBe(
      buildScmDiffSnapshotSignature({ ...base, fetchedAt: 2 }),
    );
  });

  it('changes when the repository default branch is detected later', () => {
    const base = makeSnapshot({
      repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
        worktrees: [],
        remotes: [],
      },
    });
    const withDefaultBranch = makeSnapshot({
      ...base,
      repo: {
        ...base.repo,
        defaultBranch: 'release/2026',
      },
    });

    expect(buildSnapshotSignature(withDefaultBranch)).not.toBe(buildSnapshotSignature(base));
  });

  it('changes when the configured remotes change without file or branch changes', () => {
    const base = makeSnapshot({
      repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
        worktrees: [],
        remotes: [{ name: 'origin', fetchUrl: 'git@example.com:one.git' }],
      },
    });
    const withDifferentRemote = makeSnapshot({
      ...base,
      repo: {
        ...base.repo,
        remotes: [{ name: 'upstream', fetchUrl: 'git@example.com:two.git' }],
      },
    });

    expect(buildSnapshotSignature(withDifferentRemote)).not.toBe(buildSnapshotSignature(base));
  });

  it('changes when the branch operation state changes without file or branch changes', () => {
    const base = makeSnapshot({
      repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
        worktrees: [],
        remotes: [],
      },
      operationState: {
        kind: 'merge',
        sourceRef: 'origin/main',
        canContinue: true,
        canAbort: true,
      },
    });
    const withDifferentOperationState = makeSnapshot({
      ...base,
      operationState: {
        kind: 'rebase',
        sourceRef: 'origin/release',
        canContinue: false,
        canAbort: true,
      },
    });

    expect(buildSnapshotSignature(withDifferentOperationState)).not.toBe(buildSnapshotSignature(base));
  });

  it('changes when HEAD or upstream object ids move without a status shape change', () => {
    const base = makeSnapshot({ repo: { isRepo: true, rootPath: '/repo' } });
    const observed = { ...base, branch: { ...base.branch, headOid: 'a'.repeat(40), upstreamOid: 'b'.repeat(40) } };
    expect(buildSnapshotSignature({ ...observed, branch: { ...observed.branch, headOid: 'c'.repeat(40) } })).not.toBe(buildSnapshotSignature(observed));
    expect(buildSnapshotSignature({ ...observed, branch: { ...observed.branch, upstreamOid: 'd'.repeat(40) } })).not.toBe(buildSnapshotSignature(observed));
  });
});


describe('clearSearchCacheForProject', () => {
  it('clears the search caches of the given sessions only, without loading the full file-search module', async () => {
    const machine = createMachineFixture({ id: 'clear-machine' });
    storage.setState({
      machines: { [machine.id]: machine },
      // The workspace caches are keyed by the Session's Home, carried on the active Session entity.
      sessions: sessionsState({
        'clear-s1': { serverId: 'clear-home', metadata: metadata({ machineId: machine.id, path: '/clear-a' }) },
        'clear-s2': { serverId: 'clear-home', metadata: metadata({ machineId: machine.id, path: '/clear-b' }) },
        'clear-s3': { serverId: 'clear-home', metadata: metadata({ machineId: machine.id, path: '/clear-a/apps/ui' }) },
      }),
    });
    const entries = [{ name: 'README.md', type: 'file' as const }];
    for (const sessionId of ['clear-s1', 'clear-s2', 'clear-s3']) {
      setCachedRepositoryDirectoryEntries({ sessionId, directoryPath: '', entries });
      expect(getCachedRepositoryDirectoryEntries({ sessionId, directoryPath: '' })).toEqual(entries);
    }
    const clearedSuggestionSessions: Array<string | undefined> = [];
    const unregister = registerSuggestionFileSearchCacheClearer((sessionId) => clearedSuggestionSessions.push(sessionId));
    try {
      await clearSearchCacheForProject([
        { sessionId: 'clear-s1', serverId: null },
        { sessionId: 'clear-s3', serverId: null },
      ]);
    } finally {
      unregister();
    }

    expect(clearedSuggestionSessions).toEqual(['clear-s1', 'clear-s3']);
    expect(getCachedRepositoryDirectoryEntries({ sessionId: 'clear-s1', directoryPath: '' })).toBeNull();
    expect(getCachedRepositoryDirectoryEntries({ sessionId: 'clear-s2', directoryPath: '' })).toEqual(entries);
    expect(getCachedRepositoryDirectoryEntries({ sessionId: 'clear-s3', directoryPath: '' })).toBeNull();
  });
});

describe('getRepoScopeSessionIds', () => {
  it('does not group repo sessions by host when machine identity is missing', () => {
    storage.setState({
      sessions: sessionsState({
        s1: { metadata: metadata({ host: 'devbox', path: '/repo' }) },
        s2: { metadata: metadata({ host: 'devbox', path: '/repo/apps/ui' }) },
        s3: { metadata: metadata({ host: 'other', path: '/repo/apps/ui' }) },
        s4: { metadata: metadata({ machineId: 'machine-a', path: '/repo/apps/ui' }) },
      }),
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });

  it('groups repo sessions by normalized host scope when machineId is missing', () => {
    storage.setState({
      sessions: sessionsState({
        s1: { metadata: metadata({ host: 'DEVBOX.local', path: '/repo' }) },
        s2: { metadata: metadata({ host: 'devbox', path: '/repo/apps/ui' }) },
        s3: { metadata: metadata({ host: 'other.local', path: '/repo/apps/ui' }) },
      }),
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });

  it('groups layout-v1 repo sessions by owner workspace scope instead of shared metadata', () => {
    storage.setState({
      sessions: sessionsState({
        s1: {
          metadataLayoutVersion: 1,
          metadata: metadata({ v: 1, host: 'shared-decoy', path: '/shared-decoy' }),
          ownerMetadataView: metadata({ host: 'DEVBOX.local', path: '/repo' }),
        },
        s2: {
          metadataLayoutVersion: 1,
          metadata: metadata({ v: 1, host: 'other-shared-decoy', path: '/other-shared-decoy' }),
          ownerMetadataView: metadata({ host: 'devbox', path: '/repo/apps/ui' }),
        },
        s3: {
          metadataLayoutVersion: 1,
          metadata: metadata({ v: 1, host: 'shared-decoy', path: '/shared-decoy' }),
          ownerMetadataView: metadata({ host: 'other.local', path: '/repo/apps/server' }),
        },
      }),
    });

    expect(getRepoScopeSessionIds('s1', '/repo').sort()).toEqual(['s1', 's2']);
  });

  it('returns only the reference session when scope is unknown', () => {
    storage.setState({
      sessions: sessionsState({
        s1: { metadata: metadata({ path: '/repo' }) },
        s2: { metadata: metadata({ host: '', path: '/repo/apps/ui' }) },
      }),
    });

    expect(getRepoScopeSessionIds('s1', '/repo')).toEqual(['s1']);
  });

  it('includes sessions using project workspace fallback when metadata path is missing', () => {
    const workspaces = {
      'fallback-reference': { machineId: 'machine-a', path: '/repo' },
      'fallback-member': { machineId: 'machine-a', path: '/repo/apps/ui' },
      'fallback-other-machine': { machineId: 'machine-b', path: '/repo/apps/server' },
      'fallback-outside': { machineId: 'machine-a', path: '/elsewhere' },
    };
    const withPaths = (pathFor: (path: string) => string) => sessionsState(Object.fromEntries(Object.entries(workspaces)
      .map(([id, workspace]) => [id, { metadata: metadata({ machineId: workspace.machineId, path: pathFor(workspace.path) }) }])));
    // The project registry observes each workspace before the path leaves the session metadata.
    storage.setState({ sessions: withPaths((path) => path) });
    for (const [id, workspace] of Object.entries(workspaces)) {
      expect(storage.getState().getProjectForSession(id)?.key.rootPath).toBe(workspace.path);
    }
    storage.setState({ sessions: withPaths(() => '') });

    expect(getRepoScopeSessionIds('fallback-reference', '/repo').sort()).toEqual(['fallback-member', 'fallback-reference']);
  });

  it('groups direct-session repo scopes by the linked direct machine id', () => {
    storage.setState({
      sessions: sessionsState({
        s1: {
          metadata: metadata({
            path: '/repo',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-direct',
              remoteSessionId: 'remote-1',
              source: { kind: 'codexHome', home: 'user' },
            },
          }),
        },
        s2: {
          metadata: metadata({
            path: '/repo/apps/ui',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-direct',
              remoteSessionId: 'remote-2',
              source: { kind: 'codexHome', home: 'user' },
            },
          }),
        },
        s3: {
          metadata: metadata({
            path: '/repo/apps/server',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-other',
              remoteSessionId: 'remote-3',
              source: { kind: 'codexHome', home: 'user' },
            },
          }),
        },
      }),
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });
});
