import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

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
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

function createHarness() {
  const store = createStore<StorageState>()((set, get) => ({
    ...storage.getInitialState(),
    ...createSessionsDomain<StorageState>({ set, get }),
    machines: { m1: createMachineFixture({ id: 'm1', metadata: { ...createMachineFixture().metadata!, homeDir: '/home/u' } }) },
    machineDisplayById: {}, sessionMessages: {}, sessionMessagesHistoryStartLoaded: {},
  }));
  let setCount = 0;
  store.subscribe(() => { setCount += 1; });
  return { get: store.getState, set: store.setState, domain: store.getState(), getSetCount: () => setCount };
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
    changedFileCount: 1,
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

  it('keeps an empty snapshot clear a no-op without creating a project', () => {
    const { domain, get, getSetCount } = createHarness();
    const previous = get();
    const notifications = getSetCount();
    domain.updateWorkspaceScmSnapshot({ serverId: 'pub-empty', machineId: 'm1', rootPath: '/empty' }, null);
    expect(get()).toBe(previous);
    expect(getSetCount()).toBe(notifications);
    expect(projectManager.getProjectForWorkspace({ serverId: 'pub-empty', machineId: 'm1', rootPath: '/empty' })).toBeNull();
  });

  it.each([false, true])('suppresses an equal SCM batch in the real store (exact Home: %s), while retaining real changes', (exactHome) => {
    const { get, domain, getSetCount } = createHarness();
    const serverId = getActiveServerSnapshot().serverId;
    domain.applySessions([{ ...makeSession('s1'), serverId }]);
    const first = { sessionId: 's1', snapshot: makeSnapshot(100), status: makeStatus(100) };
    const publish = exactHome ? { ...first, serverId } : first;
    domain.publishSessionProjectScmSnapshots([publish]);
    const settled = get();
    const notifications = getSetCount();
    domain.publishSessionProjectScmSnapshots([structuredClone(publish)]);
    expect(get()).toBe(settled);
    expect(getSetCount()).toBe(notifications);
    domain.publishSessionProjectScmSnapshots([{ ...publish, status: makeStatus(200) }]);
    expect(getSetCount()).toBe(notifications + 1);
  });

  it('isolates duplicate Session SCM snapshots, selections and operation locks by Home', () => {
    const { get, set, domain } = createHarness();
    const session = makeSession('same');
    get().sessions = { same: { ...session, serverId: 'a' } };
    get().sessionListRowsByServerId = {
      a: { same: { ...session, serverId: 'a' } },
      b: { same: { ...session, serverId: 'b' } },
    };
    const machine = { ...get().machines.m1, active: true };
    get().machineListByServerId = { a: [machine], b: [machine] };
    const a = makeSnapshot(100);
    const b = { ...makeSnapshot(200), branch: { ...a.branch, head: 'other' } };
    domain.publishSessionProjectScmSnapshots([
      { sessionId: 'same', serverId: 'a', snapshot: a, status: makeStatus(100) },
      { sessionId: 'same', serverId: 'b', snapshot: b, status: makeStatus(200) },
    ]);
    expect(domain.getSessionProjectScmSnapshot('same', 'a')).toBe(a);
    expect(domain.getSessionProjectScmSnapshot('same', 'b')).toBe(b);
    domain.markSessionProjectScmCommitSelectionPaths('same', ['a.ts'], 'a');
    domain.markSessionProjectScmCommitSelectionPaths('same', ['b.ts'], 'b');
    expect(domain.getSessionProjectScmCommitSelectionPaths('same', 'a')).toEqual(['a.ts']);
    expect(domain.getSessionProjectScmCommitSelectionPaths('same', 'b')).toEqual(['b.ts']);
    const lockA = domain.beginSessionProjectScmOperation('same', 'commit', 'a');
    const lockB = domain.beginSessionProjectScmOperation('same', 'commit', 'b');
    expect(lockA.started).toBe(true);
    expect(lockB.started).toBe(true);
    if (!lockA.started || !lockB.started) throw new Error('Expected independent locks');
    expect(domain.finishSessionProjectScmOperation('same', lockA.operation.id, 'b')).toBe(false);
    expect(domain.getSessionProjectScmInFlightOperation('same', 'b')).toEqual(lockB.operation);
    set({ sessionListRowsByServerId: { ...get().sessionListRowsByServerId, b: {} } });
    expect(domain.getSessionProjectScmSnapshot('same', 'b')).toBeNull();
    domain.clearSessionProjectScmCommitSelectionPaths('same', 'b');
    expect(domain.getSessionProjectScmCommitSelectionPaths('same', 'a')).toEqual(['a.ts']);
    expect(domain.beginSessionProjectScmOperation('same', 'commit', 'b')).toEqual({ started: false, reason: 'missing_project', inFlight: null });
  });

  it('publishes snapshots to multiple sessions with a single store notification', () => {
    const { get, domain, getSetCount } = createHarness();
    domain.applySessions([makeSession('s1'), makeSession('s2'), makeSession('s3')]);

    // A stale touched path that the publish prune must drop.
    domain.markWorkspaceScmTouchedPathsForSession('s1', ['gone.ts', 'src/a.ts']);
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
    expect(domain.getWorkspaceScmTouchedPathsForSession('s1')).toEqual(['src/a.ts']);
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
