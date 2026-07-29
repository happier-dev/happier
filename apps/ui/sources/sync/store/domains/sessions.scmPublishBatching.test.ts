import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return mmkvStore.get(key);
    }
    set(key: string, value: string) {
      mmkvStore.set(key, value);
    }
    delete(key: string) {
      mmkvStore.delete(key);
    }
    clearAll() {
      mmkvStore.clear();
    }
  }
  return { MMKV };
});

import { createSessionsDomain } from './sessions';
import { projectManager } from '../../runtime/orchestration/projectManager';

function createHarness() {
  let state: any = {
    sessions: {},
    concurrentSessionListCacheByServerId: {},
    sessionScmStatus: {},
    sessionLastViewed: {},
    sessionRepositoryTreeExpandedPathsBySessionId: {},
    reviewCommentsDraftsBySessionId: {},
    actionDraftsBySessionId: {},
    isDataReady: false,
    machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
    machineDisplayById: {},
    sessionMessages: {},
    settings: { groupInactiveSessionsByProject: false },
  };
  let setCount = 0;

  const get = () => state;
  const set = (updater: any) => {
    setCount += 1;
    const next = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...next };
  };

  const domain = createSessionsDomain({ get, set } as any);
  set(domain as any);
  setCount = 0;
  return { get, domain, getSetCount: () => setCount };
}

function makeSession(id: string) {
  return {
    id,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 1,
  } as any;
}

function makeSnapshot(fetchedAt: number) {
  return {
    projectKey: 'm1:/home/u/repo',
    fetchedAt,
    repo: {
      isRepo: true,
      rootPath: '/home/u/repo',
      backendId: 'git',
      mode: '.git',
      worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
    },
    capabilities: {
      writeInclude: true,
      writeExclude: true,
      worktreeCreate: true,
    },
    branch: {
      head: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      detached: false,
    },
    entries: [{
      path: 'src/a.ts',
      previousPath: null,
      kind: 'modified',
      includeStatus: 'unmodified',
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
    }],
    hasConflicts: false,
    totals: {
      includedFiles: 0,
      pendingFiles: 1,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 1,
      pendingRemoved: 0,
    },
    stashCount: 0,
  } as any;
}

function makeStatus(lastUpdatedAt: number) {
  return {
    branch: 'main',
    isDirty: true,
    modifiedCount: 1,
    untrackedCount: 0,
    includedCount: 0,
    lastUpdatedAt,
    includedLinesAdded: 0,
    includedLinesRemoved: 0,
    pendingLinesAdded: 1,
    pendingLinesRemoved: 0,
    linesAdded: 1,
    linesRemoved: 0,
    linesChanged: 1,
  } as any;
}

describe('sessions domain: batched project SCM snapshot publish', () => {
  beforeEach(() => {
    projectManager.clear();
  });

  it('publishes snapshots to multiple sessions with a single store notification', () => {
    const { get, domain, getSetCount } = createHarness();
    domain.applySessions([makeSession('s1'), makeSession('s2'), makeSession('s3')]);

    // A stale touched path that the publish prune must drop.
    domain.markSessionProjectScmTouchedPaths('s1', ['gone.ts', 'src/a.ts']);
    const setCountBeforePublish = getSetCount();

    const snapshot = makeSnapshot(100);
    const status = makeStatus(100);
    domain.publishSessionProjectScmSnapshots([
      { sessionId: 's1', snapshot, status },
      { sessionId: 's2', snapshot, status },
      { sessionId: 's3', snapshot, status },
    ]);

    expect(getSetCount() - setCountBeforePublish).toBe(1);
    expect(get().sessionScmStatus.s1).toBe(status);
    expect(get().sessionScmStatus.s2).toBe(status);
    expect(get().sessionScmStatus.s3).toBe(status);
    expect(domain.getSessionProjectScmSnapshot('s1')).toBe(snapshot);
    expect(domain.getSessionProjectScmSnapshot('s3')).toBe(snapshot);
    expect(domain.getSessionProjectScmTouchedPaths('s1')).toEqual(['src/a.ts']);
  });

  it('keeps the equivalent-snapshot identity when only fetchedAt changes and still notifies once', () => {
    const { domain, getSetCount } = createHarness();
    domain.applySessions([makeSession('s1')]);

    const first = makeSnapshot(100);
    domain.publishSessionProjectScmSnapshots([
      { sessionId: 's1', snapshot: first, status: makeStatus(100) },
    ]);
    const setCountAfterFirst = getSetCount();

    const refreshedOnly = makeSnapshot(200);
    domain.publishSessionProjectScmSnapshots([
      { sessionId: 's1', snapshot: refreshedOnly, status: makeStatus(200) },
    ]);

    // Snapshot equivalence (ignoring fetchedAt) must keep the previous object identity.
    expect(domain.getSessionProjectScmSnapshot('s1')).toBe(first);
    expect(getSetCount() - setCountAfterFirst).toBe(1);
  });

  it('clears a previously recorded snapshot error as part of the same publish', () => {
    const { domain } = createHarness();
    domain.applySessions([makeSession('s1')]);

    domain.updateSessionProjectScmSnapshotError('s1', { kind: 'daemon_unreachable', message: 'x', occurredAt: 1 } as any);
    expect(domain.getSessionProjectScmSnapshotError('s1')).not.toBeNull();

    domain.publishSessionProjectScmSnapshots([
      { sessionId: 's1', snapshot: makeSnapshot(100), status: makeStatus(100) },
    ]);

    expect(domain.getSessionProjectScmSnapshotError('s1')).toBeNull();
  });
});
