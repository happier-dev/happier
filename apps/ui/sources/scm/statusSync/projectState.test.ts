import { describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildSnapshotSignature, clearSearchCacheForProject, getRepoScopeSessionIds } from './projectState';

const getStateMock = vi.hoisted(() => vi.fn());
const clearSuggestionFileSearchCacheMock = vi.hoisted(() => vi.fn());
const clearCachedRepositoryDirectoryEntriesMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: getStateMock,
  },
});
});

vi.mock('@/sync/domains/input/suggestionFile', () => {
    throw new Error('projectState must not load the full file-search suggestion module when clearing caches');
});

vi.mock('@/sync/domains/input/suggestionFileCacheInvalidation', () => ({
    clearSuggestionFileSearchCache: (sessionId: string) => clearSuggestionFileSearchCacheMock(sessionId),
}));

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    clearCachedRepositoryDirectoryEntries: (input: { sessionId: string }) =>
        clearCachedRepositoryDirectoryEntriesMock(input),
}));

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
});


describe('clearSearchCacheForProject', () => {
  it('clears matching session caches without loading the full file-search module', async () => {
    clearSuggestionFileSearchCacheMock.mockClear();
    clearCachedRepositoryDirectoryEntriesMock.mockClear();

    await clearSearchCacheForProject(new Map([
      ['s1', 'project-a'],
      ['s2', 'project-b'],
      ['s3', 'project-a'],
    ]), 'project-a');

    expect(clearSuggestionFileSearchCacheMock).toHaveBeenCalledTimes(2);
    expect(clearSuggestionFileSearchCacheMock).toHaveBeenNthCalledWith(1, 's1');
    expect(clearSuggestionFileSearchCacheMock).toHaveBeenNthCalledWith(2, 's3');
    expect(clearCachedRepositoryDirectoryEntriesMock).toHaveBeenCalledTimes(2);
    expect(clearCachedRepositoryDirectoryEntriesMock).toHaveBeenNthCalledWith(1, { sessionId: 's1' });
    expect(clearCachedRepositoryDirectoryEntriesMock).toHaveBeenNthCalledWith(2, { sessionId: 's3' });
  });
});

describe('getRepoScopeSessionIds', () => {
  it('does not group repo sessions by host when machine identity is missing', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { host: 'devbox', path: '/repo' } },
        s2: { id: 's2', metadata: { host: 'devbox', path: '/repo/apps/ui' } },
        s3: { id: 's3', metadata: { host: 'other', path: '/repo/apps/ui' } },
        s4: { id: 's4', metadata: { machineId: 'machine-a', path: '/repo/apps/ui' } },
      },
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });

  it('groups repo sessions by normalized host scope when machineId is missing', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { host: 'DEVBOX.local', path: '/repo' } },
        s2: { id: 's2', metadata: { host: 'devbox', path: '/repo/apps/ui' } },
        s3: { id: 's3', metadata: { host: 'other.local', path: '/repo/apps/ui' } },
      },
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });

  it('groups layout-v1 repo sessions by owner workspace scope instead of shared metadata', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: {
          id: 's1',
          metadataLayoutVersion: 1,
          metadata: { v: 1, host: 'shared-decoy', path: '/shared-decoy' },
          ownerMetadataView: { host: 'DEVBOX.local', path: '/repo' },
        },
        s2: {
          id: 's2',
          metadataLayoutVersion: 1,
          metadata: { v: 1, host: 'other-shared-decoy', path: '/other-shared-decoy' },
          ownerMetadataView: { host: 'devbox', path: '/repo/apps/ui' },
        },
        s3: {
          id: 's3',
          metadataLayoutVersion: 1,
          metadata: { v: 1, host: 'shared-decoy', path: '/shared-decoy' },
          ownerMetadataView: { host: 'other.local', path: '/repo/apps/server' },
        },
      },
    });

    expect(getRepoScopeSessionIds('s1', '/repo').sort()).toEqual(['s1', 's2']);
  });

  it('returns only the reference session when scope is unknown', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { path: '/repo' } },
        s2: { id: 's2', metadata: { host: '', path: '/repo/apps/ui' } },
      },
    });

    expect(getRepoScopeSessionIds('s1', '/repo')).toEqual(['s1']);
  });

  it('includes sessions using project workspace fallback when metadata path is missing', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: null } },
        s2: { id: 's2', metadata: { machineId: 'machine-a', path: '/repo/apps/ui' } },
        s3: { id: 's3', metadata: { machineId: 'machine-b', path: '/repo/apps/server' } },
      },
      getProjectForSession: (sessionId: string) => {
        if (sessionId === 's1') {
          return { key: { machineId: 'machine-a', path: '/repo' } };
        }
        if (sessionId === 's2') {
          return { key: { machineId: 'machine-a', path: '/repo/apps/ui' } };
        }
        return null;
      },
    });

    expect(getRepoScopeSessionIds('s1', '/repo').sort()).toEqual(['s1', 's2']);
  });

  it('groups direct-session repo scopes by the linked direct machine id', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: {
          id: 's1',
          metadata: {
            path: '/repo',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-direct',
              remoteSessionId: 'remote-1',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        },
        s2: {
          id: 's2',
          metadata: {
            path: '/repo/apps/ui',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-direct',
              remoteSessionId: 'remote-2',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        },
        s3: {
          id: 's3',
          metadata: {
            path: '/repo/apps/server',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-other',
              remoteSessionId: 'remote-3',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        },
      },
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });
});
