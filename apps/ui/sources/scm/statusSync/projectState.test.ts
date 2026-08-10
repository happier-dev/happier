import { describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { EMPTY_SCM_CAPABILITIES } from '../core/snapshotMappers';
import { buildSnapshotSignature, clearSearchCacheForProject, getRepoScopeSessionIds } from './projectState';

const getStateMock = vi.hoisted(() => vi.fn());
const clearSuggestionFileSearchCacheMock = vi.hoisted(() => vi.fn());
const resolveSessionFileSuggestionScopeMock = vi.hoisted(() => vi.fn());

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
    clearSuggestionFileSearchCache: (scope: unknown) => clearSuggestionFileSearchCacheMock(scope),
}));

vi.mock('@/sync/ops/resolveSessionFileSuggestionScope', () => ({
    resolveSessionFileSuggestionScope: (sessionId: string) => resolveSessionFileSuggestionScopeMock(sessionId),
}));

function snapshot(defaultBranch?: string | null): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
        },
        capabilities: EMPTY_SCM_CAPABILITIES,
        branch: {
            head: 'feature/update',
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
    };
}

describe('buildSnapshotSignature', () => {
  it('changes when the repository default branch is detected later', () => {
    expect(buildSnapshotSignature(snapshot())).not.toBe(
      buildSnapshotSignature(snapshot('release/2026')),
    );
  });

  it('ignores refresh timestamps so unchanged auto-refreshes can be no-ops', () => {
    expect(buildSnapshotSignature({ ...snapshot(), fetchedAt: 1 })).toBe(
      buildSnapshotSignature({ ...snapshot(), fetchedAt: 2 }),
    );
  });

  it('changes when pull request metadata changes', () => {
    const provider = {
      kind: 'github' as const,
      name: 'GitHub',
      baseUrl: 'https://github.com',
      nameWithOwner: 'happier/dev',
      remoteName: 'origin',
    };

    expect(buildSnapshotSignature(snapshot())).not.toBe(
      buildSnapshotSignature({
        ...snapshot(),
        hostingProvider: provider,
        pullRequest: {
          provider,
          number: 42,
          title: 'Add PR workflow',
          url: 'https://github.com/happier/dev/pull/42',
          baseBranch: 'main',
          headBranch: 'feature/update',
          state: 'open',
        },
      }),
    );
  });

  it('is stable when entries arrive in a different order', () => {
    const first = {
      ...snapshot(),
      entries: [
        {
          path: 'b.ts',
          previousPath: null,
          kind: 'modified' as const,
          includeStatus: 'excluded',
          pendingStatus: 'modified',
          hasIncludedDelta: false,
          hasPendingDelta: true,
          stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
            isBinary: false,
          },
        },
        {
          path: 'a.ts',
          previousPath: null,
          kind: 'modified' as const,
          includeStatus: 'excluded',
          pendingStatus: 'modified',
          hasIncludedDelta: false,
          hasPendingDelta: true,
          stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
            isBinary: false,
          },
        },
      ],
    };
    expect(buildSnapshotSignature(first)).toBe(
      buildSnapshotSignature({ ...first, entries: [...first.entries].reverse() }),
    );
  });
});


describe('clearSearchCacheForProject', () => {
  it('clears matching session caches without loading the full file-search module', async () => {
    clearSuggestionFileSearchCacheMock.mockClear();
    resolveSessionFileSuggestionScopeMock.mockImplementation((sessionId: string) => ({
      machineId: `machine-${sessionId}`,
      path: `/work/${sessionId}`,
      serverId: 'server-1',
    }));

    await clearSearchCacheForProject(new Map([
      ['s1', 'project-a'],
      ['s2', 'project-b'],
      ['s3', 'project-a'],
    ]), 'project-a');

    expect(clearSuggestionFileSearchCacheMock).toHaveBeenCalledTimes(2);
    expect(clearSuggestionFileSearchCacheMock).toHaveBeenNthCalledWith(1, {
      machineId: 'machine-s1',
      path: '/work/s1',
      serverId: 'server-1',
    });
    expect(clearSuggestionFileSearchCacheMock).toHaveBeenNthCalledWith(2, {
      machineId: 'machine-s3',
      path: '/work/s3',
      serverId: 'server-1',
    });
  });

  it('does not clear an unrelated cache when a matching session has no machine scope', async () => {
    clearSuggestionFileSearchCacheMock.mockClear();
    resolveSessionFileSuggestionScopeMock.mockReturnValue(null);

    await clearSearchCacheForProject(new Map([['s1', 'project-a']]), 'project-a');

    expect(clearSuggestionFileSearchCacheMock).not.toHaveBeenCalled();
  });
});

describe('getRepoScopeSessionIds', () => {
  it('does not group repo sessions by host-only scope when machineId is missing', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { host: 'devbox', path: '/repo' } },
        s2: { id: 's2', metadata: { host: 'devbox', path: '/repo/apps/ui' } },
        s3: { id: 's3', metadata: { host: 'other', path: '/repo/apps/ui' } },
        s4: { id: 's4', metadata: { machineId: 'machine-a', path: '/repo/apps/ui' } },
      },
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1']);
  });

  it('groups direct-session repo scopes by the linked direct machine id', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: {
          id: 's1',
          metadata: {
            path: '/repo',
            directSessionV1: {
              v: 1,
              providerId: 'codex',
              machineId: 'm-direct',
              remoteSessionId: 'remote-1',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        },
        s2: {
          id: 's2',
          metadata: {
            path: '/repo/apps/ui',
            directSessionV1: {
              v: 1,
              providerId: 'codex',
              machineId: 'm-direct',
              remoteSessionId: 'remote-2',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        },
        s3: {
          id: 's3',
          metadata: {
            path: '/repo/apps/server',
            directSessionV1: {
              v: 1,
              providerId: 'codex',
              machineId: 'm-other',
              remoteSessionId: 'remote-3',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
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

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });
});
