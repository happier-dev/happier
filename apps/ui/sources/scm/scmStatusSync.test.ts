import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EMPTY_SCM_CAPABILITIES } from './core/snapshotMappers';
import { buildSnapshotSignature } from './statusSync/projectState';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    ATTRIBUTION_INVALIDATION_WINDOW_MS,
    collectChangedPaths,
    isSessionPathWithinRepoRoot,
    shouldAttributeChangedPaths,
    ScmStatusSync,
} from './scmStatusSync';

const machineRpc = vi.hoisted(() => vi.fn());
// The authenticated Machine RPC transport is external; repository resolution,
// snapshot mapping, sync lifetimes and storage publication remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

function makeSnapshot(entries: ScmWorkingSnapshot['entries']): ScmWorkingSnapshot {
    return {
        projectKey: 'm:/repo',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: entries.filter((e) => e.hasIncludedDelta).length,
            pendingFiles: entries.filter((e) => e.hasPendingDelta).length,
            untrackedFiles: entries.filter((e) => e.kind === 'untracked').length,
            includedAdded: entries.reduce((acc, e) => acc + e.stats.includedAdded, 0),
            includedRemoved: entries.reduce((acc, e) => acc + e.stats.includedRemoved, 0),
            pendingAdded: entries.reduce((acc, e) => acc + e.stats.pendingAdded, 0),
            pendingRemoved: entries.reduce((acc, e) => acc + e.stats.pendingRemoved, 0),
        },
    };
}

describe('isSessionPathWithinRepoRoot', () => {
    it('matches root path and nested paths only', () => {
        expect(isSessionPathWithinRepoRoot('/repo', '/repo')).toBe(true);
        expect(isSessionPathWithinRepoRoot('/repo/apps/ui', '/repo')).toBe(true);
        expect(isSessionPathWithinRepoRoot('/repo-other', '/repo')).toBe(false);
        expect(isSessionPathWithinRepoRoot('/tmp/repo', '/repo')).toBe(false);
    });

    it('does not reinterpret an unknown home as the filesystem root', () => {
        expect(isSessionPathWithinRepoRoot('~/repo', '/repo')).toBe(false);
        expect(isSessionPathWithinRepoRoot('~/repo-other', '/repo')).toBe(false);
    });
});

describe('repository scope snapshot publication and reuse', () => {
    it('publishes changed HEAD and upstream observations even when status shape is unchanged', () => {
        const base = makeSnapshot([]);
        const observed = { ...base, branch: { ...base.branch, headOid: 'a'.repeat(40), upstreamOid: 'b'.repeat(40) } };
        expect(buildSnapshotSignature({ ...observed, branch: { ...observed.branch, headOid: 'c'.repeat(40) } })).not.toBe(buildSnapshotSignature(observed));
        expect(buildSnapshotSignature({ ...observed, branch: { ...observed.branch, upstreamOid: 'd'.repeat(40) } })).not.toBe(buildSnapshotSignature(observed));
    });

    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.restoreAllMocks();
    });

    it('keeps identical session and repository IDs on different Homes in independent sync lifetimes', () => {
        const machine = createMachineFixture({ id: 'm' });
        const base = createSessionFixture();
        const session = createSessionFixture({ id: 'same', metadata: { ...base.metadata!, machineId: 'm', path: '/repo' } });
        storage.setState({
            sessions: { same: session },
            machineListByServerId: { a: [machine], b: [machine] },
            sessionListRowsByServerId: { a: { same: session }, b: { same: session } },
        });
        const syncer = new ScmStatusSync();
        const a = syncer.getSync('same', 'a');
        const b = syncer.getSync('same', 'b');
        expect(a).not.toBe(b);
        expect(syncer.getSync('same', 'a')).toBe(a);
        syncer.stop('same', 'b');
        expect(syncer.getSync('same', 'a')).toBe(a);
        syncer.stop('same', 'a');
    });

    it('clears only the deleted carrier Home when the same Session id lives on another Home', () => {
        const machine = createMachineFixture({ id: 'm', active: true, activeAt: 1 });
        const base = createSessionFixture();
        const session = createSessionFixture({ id: 'same', metadata: { ...base.metadata!, machineId: 'm', path: '/repo' } });
        storage.setState({
            machines: { m: machine },
            machineListByServerId: { a: [machine], b: [machine] },
            sessions: { same: session },
            sessionListRowsByServerId: { a: { same: session }, b: { same: session } },
        });
        const syncer = new ScmStatusSync();
        const a = syncer.getSync('same', 'a');
        const b = syncer.getSync('same', 'b');

        // The canonical deletion owner knows the retired carrier's Home; clearing by
        // bare id alone leaves the exact-Home mapping and its project sync alive.
        syncer.clearForSession('same', 'a');

        expect(syncer.getSync('same', 'a')).not.toBe(a);
        expect(syncer.getSync('same', 'b')).toBe(b);
        syncer.stop('same', 'a');
        syncer.stop('same', 'b');
    });

    it.each([
        { root: 'c:/users/alice/repo', home: 'C:\\Users\\Alice\\', member: 'C:\\Users\\Alice\\Repo/src', late: '\\\\?\\C:\\USERS\\ALICE\\repo\\late', sibling: 'C:\\Users\\Alice\\repo2' },
        { root: '//server/share/repo', home: '\\\\Server\\Share\\', member: '\\\\?\\UNC\\SERVER\\SHARE\\Repo\\src', late: '\\\\server\\SHARE\\repo/late', sibling: '\\\\server\\share\\repo2' },
        { root: '/home/alice/repo', home: '/home/alice/', member: '~/repo/src', late: '~\\repo/late', sibling: '/home/alice2/repo' },
    ])('publishes and reuses $root across equivalent path spellings', async ({ root, home, member, late, sibling }) => {
        const machine = createMachineFixture();
        const session = (id: string, path: string, machineId = machine.id) => {
            const base = createSessionFixture();
            return createSessionFixture({ id, metadata: { ...base.metadata!, path, machineId, homeDir: undefined } });
        };
        storage.setState({
            machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, homeDir: home } } },
            sessions: {
                root: session('root', root),
                member: session('member', member),
                sibling: session('sibling', sibling),
                otherMachine: session('otherMachine', member, 'other-machine'),
            },
        });
        const rpc = machineRpc.mockResolvedValue({
            success: true,
            snapshot: { ...makeSnapshot([]), repo: { isRepo: true, rootPath: root }, capabilities: EMPTY_SCM_CAPABILITIES },
        });
        const syncer = new ScmStatusSync();
        try {
            await syncer.getSync('root').invalidateAndAwait();
            expect(storage.getState().getSessionProjectScmSnapshotError('root')).toBeNull();
            const snapshot = storage.getState().getSessionProjectScmSnapshot('root');
            expect(snapshot).not.toBeNull();
            expect(storage.getState().getSessionProjectScmSnapshot('member')).toEqual(snapshot);
            expect(storage.getState().getSessionProjectScmSnapshot('sibling')).toBeNull();
            expect(storage.getState().getSessionProjectScmSnapshot('otherMachine')).toBeNull();

            storage.setState({ sessions: { ...storage.getState().sessions, late: session('late', late) } });
            const rpcCount = rpc.mock.calls.length;
            syncer.getSync('late');
            expect(storage.getState().getSessionProjectScmSnapshot('late')).toEqual(snapshot);
            expect(rpc.mock.calls.length).toBe(rpcCount);
        } finally {
            for (const id of ['root', 'member', 'late', 'sibling', 'otherMachine']) syncer.stop(id);
        }
    });
});

describe('collectChangedPaths', () => {
    it('returns added, removed and materially changed paths between snapshots', () => {
        const before = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: ' ',
                hasIncludedDelta: true,
                hasPendingDelta: false,
                stats: {
                    includedAdded: 1,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'old.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: ' ',
                pendingStatus: 'M',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 2,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ]);

        const after = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: 'M',
                hasIncludedDelta: true,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 1,
                    includedRemoved: 0,
                    pendingAdded: 4,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'new.ts',
                previousPath: null,
                kind: 'added',
                includeStatus: 'A',
                pendingStatus: ' ',
                hasIncludedDelta: true,
                hasPendingDelta: false,
                stats: {
                    includedAdded: 8,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
        ]);

        expect(collectChangedPaths(before, after).sort()).toEqual(['a.ts', 'new.ts', 'old.ts']);
    });
});

describe('shouldAttributeChangedPaths', () => {
    it('returns true when attribution source is mutation, actor is in scope, changes exist, invalidation is fresh, and scope is single-session', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(true);
    });

    it('returns false when multiple sessions are active in the same repository scope', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1', 's2'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(false);
    });

    it('returns false when invalidation source is not mutation', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'unknown',
                scopeSessionIds: ['s1'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(false);
    });

    it('returns false when invalidation is stale', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS + 1,
            })
        ).toBe(false);
    });

    it('returns false when actor is missing, out of scope, or no changed paths exist', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: null,
                actorSource: null,
                scopeSessionIds: ['s1'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);

        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's3',
                actorSource: 'mutation',
                scopeSessionIds: ['s1', 's2'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);

        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 0,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);
    });
});
