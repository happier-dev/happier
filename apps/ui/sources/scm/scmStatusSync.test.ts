import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useSessionProjectScmSnapshot } from '@/sync/store/scmHooks';

import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EMPTY_SCM_CAPABILITIES } from './core/snapshotMappers';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { log } from '@/log';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { ScmStatusSync } from './scmStatusSync';
import { isSessionPathWithinRepoRoot } from './sync/paths';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { registerSuggestionFileSearchCacheClearer } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import {
    getCachedWorkspaceRepositoryDirectoryEntries,
    setCachedWorkspaceRepositoryDirectoryEntries,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

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
    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.restoreAllMocks();
    });

    it.each([undefined, 'exact-home'])('preserves refresh failure identity on Home %s through real repository publication', async (serverId) => {
        const machine = createMachineFixture({ id: 'r297-machine' });
        const base = createSessionFixture();
        const session = createSessionFixture({ id: 'r297-session', metadata: { ...base.metadata!, machineId: machine.id, path: '/r297-repo' } });
        storage.setState({
            machines: { [machine.id]: machine }, sessions: { [session.id]: session },
            ...(serverId ? {
                machineListByServerId: { [serverId]: [machine] },
                sessionListRowsByServerId: { [serverId]: { [session.id]: session } },
            } : {}),
        });
        const syncer = new ScmStatusSync();
        const detail = 'TypeError: Snapshot normalization failed';
        const logCount = () => log.getLogs().filter(line => line.includes(detail)).length;
        const before = logCount();
        try {
            machineRpc.mockRejectedValueOnce(new TypeError('Snapshot normalization failed\nprivate second line'));
            await syncer.getSync(session.id, serverId).invalidateAndAwait();
            const failure = storage.getState().getSessionProjectScmSnapshotError(session.id, serverId);
            expect(failure).toMatchObject({ errorCode: 'REPOSITORY_REFRESH_FAILED' });
            expect(failure?.message).not.toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
            expect(failure?.message).not.toContain('normalization');
            expect(logCount() - before).toBe(1);

            // The transport succeeds, then the real snapshot normalizer throws locally.
            machineRpc.mockResolvedValueOnce({ success: true, snapshot: { ...makeSnapshot([]), repo: undefined } });
            await syncer.getSync(session.id, serverId).invalidateAndAwait();
            expect(storage.getState().getSessionProjectScmSnapshotError(session.id, serverId))
                .toMatchObject({ errorCode: 'REPOSITORY_REFRESH_FAILED' });

            machineRpc.mockRejectedValueOnce(Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }));
            await syncer.getSync(session.id, serverId).invalidateAndAwait();
            expect(storage.getState().getSessionProjectScmSnapshotError(session.id, serverId)).toMatchObject({
                errorCode: 'BACKEND_UNAVAILABLE', message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            });
        } finally {
            syncer.stop(session.id, serverId);
        }
    });

    it('clears the exact Home workspace directory cache of the refreshed repository only', async () => {
        const serverId = 'cache-home';
        const machine = createMachineFixture({ id: 'cache-machine' });
        const base = createSessionFixture();
        const refreshed = createSessionFixture({ id: 'cache-session', metadata: { ...base.metadata!, machineId: machine.id, path: '/cache-repo' } });
        const other = createSessionFixture({ id: 'cache-other', metadata: { ...base.metadata!, machineId: machine.id, path: '/cache-other-repo' } });
        storage.setState({
            machines: { [machine.id]: machine },
            sessions: { [refreshed.id]: refreshed, [other.id]: other },
            machineListByServerId: { [serverId]: [machine] },
            sessionListRowsByServerId: { [serverId]: { [refreshed.id]: refreshed, [other.id]: other } },
        });
        const workspaceCacheKey = (sessionId: string) => {
            const target = resolveWorkspaceTargetForSessionFromState(storage.getState(), { sessionId, serverId });
            expect(target).not.toBeNull();
            return target!.workspaceCacheKey;
        };
        const entries = [{ name: 'README.md', type: 'file' as const }];
        for (const sessionId of [refreshed.id, other.id]) {
            setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: workspaceCacheKey(sessionId), directoryPath: '', entries });
        }
        machineRpc.mockResolvedValue({
            success: true,
            snapshot: { ...makeSnapshot([]), repo: { isRepo: true, rootPath: '/cache-repo' }, capabilities: EMPTY_SCM_CAPABILITIES },
        });
        const syncer = new ScmStatusSync();
        try {
            // The other repository's Session holds a sync too, so only the project filter can keep its cache.
            syncer.getSync(other.id, serverId);
            await syncer.getSync(refreshed.id, serverId).invalidateAndAwait();
            expect(storage.getState().getSessionProjectScmSnapshot(refreshed.id, serverId)?.repo.rootPath).toBe('/cache-repo');
            expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: workspaceCacheKey(refreshed.id), directoryPath: '' })).toBeNull();
            expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: workspaceCacheKey(other.id), directoryPath: '' })).toEqual(entries);
        } finally {
            syncer.stop(refreshed.id, serverId);
            syncer.stop(other.id, serverId);
        }
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

describe('changed-file delivery follows consumption', () => {
    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.restoreAllMocks();
    });

    it.each([undefined, 'exact-home'])('reads counts only until a list consumer is presented, and agent edits read no list (Home %s)', async (serverId) => {
        const machine = createMachineFixture({ id: `delivery-machine-${serverId ?? 'active'}` });
        const base = createSessionFixture();
        const session = createSessionFixture({ id: `delivery-session-${serverId ?? 'active'}`,
            metadata: { ...base.metadata!, machineId: machine.id, path: `/delivery-repo-${serverId ?? 'active'}` } });
        storage.setState({
            machines: { [machine.id]: machine }, sessions: { [session.id]: session },
            ...(serverId ? {
                machineListByServerId: { [serverId]: [machine] },
                sessionListRowsByServerId: { [serverId]: { [session.id]: session } },
            } : {}),
        });
        const rootPath = `/delivery-repo-${serverId ?? 'active'}`;
        const entry = (path: string) => ({ path, previousPath: null, kind: 'modified' as const, includeStatus: '.', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false } });
        let edits = 1;
        machineRpc.mockImplementation(async (request) => {
            // A Machine read takes time: a pane's own refresh arrives while the list upgrade is in flight.
            await new Promise((resolve) => setTimeout(resolve, 30));
            const full = makeSnapshot(Array.from({ length: edits }, (_, index) => entry(`src/file-${index}.ts`)));
            const snapshot = { ...full, repo: { isRepo: true, rootPath }, capabilities: EMPTY_SCM_CAPABILITIES };
            return { success: true, snapshot: request.payload?.detail === 'summary'
                ? { ...snapshot, entries: [], detail: 'summary', summary: { changedFiles: edits, includedAdded: 0, includedRemoved: 0, pendingAdded: 2 * edits, pendingRemoved: edits } }
                : snapshot };
        });
        const details = () => machineRpc.mock.calls.filter(([request]) => request?.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)
            .map(([request]) => request.payload?.detail ?? 'full');
        const syncer = new ScmStatusSync();
        try {
            // Session open (composer only), then three agent edits.
            await syncer.getSync(session.id, serverId).invalidateAndAwait();
            for (let edit = 0; edit < 3; edit += 1) {
                edits += 1;
                await syncer.invalidateFromMutationAndAwait(session.id, serverId);
            }
            expect(details()).toEqual(['summary', 'summary', 'summary', 'summary']);
            expect(storage.getState().getSessionProjectScmSnapshot(session.id, serverId)?.detail).toBe('summary');
            expect(storage.getState().getSessionProjectScmSnapshot(session.id, serverId)?.summary?.changedFiles).toBe(4);

            // The Git/Review pane is presented (list demand + its visible refresh): one full read, and
            // edits read the list while it stays.
            machineRpc.mockClear();
            const release = syncer.retainEntriesDemand(session.id, serverId);
            const stopAutoRefresh = syncer.retainAutoRefresh({ sessionId: session.id, serverId, intervalMs: 0 });
            await vi.waitFor(() => expect(details()).toHaveLength(1));
            await syncer.getSync(session.id, serverId).awaitQueue();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(details()).toEqual(['full']);
            stopAutoRefresh();
            edits += 1;
            await syncer.invalidateFromMutationAndAwait(session.id, serverId);
            expect(details()).toEqual(['full', 'full']);
            expect(storage.getState().getSessionProjectScmSnapshot(session.id, serverId)?.entries).toHaveLength(edits);

            release();
            machineRpc.mockClear();
            edits += 1;
            await syncer.invalidateFromMutationAndAwait(session.id, serverId);
            expect(details()).toEqual(['summary']);
        } finally {
            syncer.stop(session.id, serverId);
        }
    });
});

describe('a retained Session surface holds its list without reading it', () => {
    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.restoreAllMocks();
    });

    it('keeps rows hidden, reads counts while hidden, re-reads on show only if moved, and frees them on close', async () => {
        const machine = createMachineFixture({ id: 'retained-machine' });
        const base = createSessionFixture();
        const rootPath = '/retained-repo';
        const session = createSessionFixture({ id: 'retained-session', metadata: { ...base.metadata!, machineId: machine.id, path: rootPath } });
        storage.setState({ machines: { [machine.id]: machine }, sessions: { [session.id]: session } });
        const entry = (path: string) => ({ path, previousPath: null, kind: 'modified' as const, includeStatus: '.', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false } });
        let edits = 1;
        let listRead: Promise<void> | null = null;
        machineRpc.mockImplementation(async (request) => {
            if (request?.payload?.detail !== 'summary' && listRead) await listRead;
            const full = makeSnapshot(Array.from({ length: edits }, (_, index) => entry(`src/file-${index}.ts`)));
            const snapshot = { ...full, repo: { isRepo: true, rootPath }, capabilities: EMPTY_SCM_CAPABILITIES };
            return { success: true, snapshot: request.payload?.detail === 'summary'
                ? { ...snapshot, entries: [], detail: 'summary', summary: { changedFiles: edits, includedAdded: 0, includedRemoved: 0, pendingAdded: 2 * edits, pendingRemoved: edits } }
                : snapshot };
        });
        const details = () => machineRpc.mock.calls.filter(([request]) => request?.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)
            .map(([request]) => request.payload?.detail ?? 'full');
        let presented = true;
        const wrapper = ({ children }: { children?: React.ReactNode }) => React.createElement(PluginSurfaceFocusEligibilityProvider,
            { active: true, presentationActive: presented, children });
        const syncer = new ScmStatusSync();
        const hook = await renderHook(() => useSessionProjectScmSnapshot(session.id, null), { wrapper });
        const stored = () => storage.getState().getSessionProjectScmSnapshot(session.id, null);
        try {
            await syncer.getSync(session.id, null).invalidateAndAwait();
            await vi.waitFor(() => expect(hook.getCurrent()?.entries).toHaveLength(1));
            const shown = hook.getCurrent();

            // Hidden with nothing moved: rows stay everywhere, and the read carries counts only.
            presented = false;
            await hook.rerender();
            expect(hook.getCurrent()).toBe(shown);
            machineRpc.mockClear();
            await syncer.invalidateFromMutationAndAwait(session.id, null);
            expect(details()).toEqual(['summary']);
            expect(stored()?.entries).toHaveLength(1);

            // Shown again unchanged: no read.
            machineRpc.mockClear();
            presented = true;
            await hook.rerender();
            await syncer.getSync(session.id, null).awaitQueue();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(details()).toEqual([]);
            expect(hook.getCurrent()).toBe(shown);

            // Hidden while an edit lands: the slot moves to counts, the hidden reader keeps its rows.
            presented = false;
            await hook.rerender();
            edits += 1;
            await syncer.invalidateFromMutationAndAwait(session.id, null);
            expect(stored()).toMatchObject({ detail: 'summary', summary: { changedFiles: 2 } });
            expect(hook.getCurrent()).toBe(shown);

            // Shown after moving: rows at once, one background list read, then the new rows.
            machineRpc.mockClear();
            let answerListRead!: () => void;
            listRead = new Promise((resolve) => { answerListRead = resolve; });
            presented = true;
            await hook.rerender();
            expect(hook.getCurrent()).toBe(shown);
            answerListRead();
            await vi.waitFor(() => expect(hook.getCurrent()?.entries).toHaveLength(2));
            expect(details()).toEqual(['full']);

            // Closing frees the slot's rows.
            await hook.unmount();
            await vi.waitFor(() => expect(stored()?.entries).toEqual([]));
            expect(stored()).toMatchObject({ detail: 'summary', summary: { changedFiles: 2 } });
        } finally {
            syncer.stop(session.id, null);
        }
    });
});

describe('active-Home refresh lifecycle through real repository publication', () => {
    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.restoreAllMocks();
    });

    // The project registry and repository service are module singletons, so every scenario owns distinct ids.
    function seedRepository(machineId: string, sessions: Readonly<Record<string, string>>) {
        const machine = createMachineFixture({ id: machineId });
        storage.setState({
            machines: { [machine.id]: machine },
            sessions: Object.fromEntries(Object.entries(sessions).map(([id, path]) => [id, repositorySession(id, machine.id, path)])),
        });
    }
    function repositorySession(id: string, machineId: string, path: string) {
        const base = createSessionFixture();
        return createSessionFixture({ id, metadata: { ...base.metadata!, machineId, path } });
    }
    function snapshotReply(rootPath: string, head = 'main') {
        const snapshot = makeSnapshot([]);
        return {
            success: true,
            snapshot: { ...snapshot, repo: { isRepo: true, rootPath }, branch: { ...snapshot.branch, head }, capabilities: EMPTY_SCM_CAPABILITIES },
        };
    }
    const snapshotRequests = () => machineRpc.mock.calls.filter(([request]) => request?.method === RPC_METHODS.SCM_STATUS_SNAPSHOT);
    const published = (sessionId: string) => storage.getState().getSessionProjectScmSnapshot(sessionId);

    it('publishes a refresh only when the repository signature changes', async () => {
        seedRepository('dedupe-machine', { 'dedupe-session': '/dedupe-repo' });
        machineRpc
            .mockResolvedValueOnce(snapshotReply('/dedupe-repo'))
            .mockResolvedValueOnce(snapshotReply('/dedupe-repo'))
            .mockResolvedValueOnce(snapshotReply('/dedupe-repo', 'feature'));
        const clearedSearchCaches: Array<string | undefined> = [];
        const unregisterClearer = registerSuggestionFileSearchCacheClearer((sessionId) => clearedSearchCaches.push(sessionId));
        const syncer = new ScmStatusSync();
        const sync = syncer.getSync('dedupe-session');
        try {
            await sync.invalidateAndAwait();
            const first = published('dedupe-session');
            expect(first?.branch.head).toBe('main');
            expect(clearedSearchCaches).toEqual(['dedupe-session']);

            let notifications = 0;
            const unsubscribe = storage.subscribe(() => { notifications += 1; });
            try {
                // Only fetchedAt can differ: subscribers are not woken and keep the same snapshot object.
                await sync.invalidateAndAwait();
                expect(notifications).toBe(0);
                expect(published('dedupe-session')).toBe(first);
                // An unchanged signature keeps the file-search caches.
                expect(clearedSearchCaches).toEqual(['dedupe-session']);

                await sync.invalidateAndAwait();
                expect(notifications).toBeGreaterThan(0);
            } finally {
                unsubscribe();
            }
            expect(published('dedupe-session')?.branch.head).toBe('feature');
            expect(clearedSearchCaches).toEqual(['dedupe-session', 'dedupe-session']);
            expect(snapshotRequests()).toHaveLength(3);
        } finally {
            unregisterClearer();
            syncer.stop('dedupe-session');
        }
    });

    it('hydrates a session that joined the repository scope although the signature is unchanged', async () => {
        seedRepository('join-machine', { 'join-root': '/join-repo' });
        machineRpc.mockResolvedValue(snapshotReply('/join-repo'));
        const syncer = new ScmStatusSync();
        try {
            await syncer.getSync('join-root').invalidateAndAwait();
            const first = published('join-root');
            expect(first).not.toBeNull();

            // The member appears without registering a sync of its own; the next unchanged refresh reaches it.
            storage.setState({ sessions: { ...storage.getState().sessions, 'join-member': repositorySession('join-member', 'join-machine', '/join-repo/packages/app') } });
            expect(published('join-member')).toBeNull();
            await syncer.getSync('join-root').invalidateAndAwait();

            expect(published('join-member')).toEqual(first);
            expect(published('join-root')).toBe(first);
            expect(snapshotRequests()).toHaveLength(2);
        } finally {
            syncer.stop('join-root');
        }
    });

    it('keeps a held session-path sync refreshing after it moves to the repository root key', async () => {
        seedRepository('move-machine', { 'move-session': '/move-repo/packages/app' });
        machineRpc
            .mockResolvedValueOnce(snapshotReply('/move-repo'))
            .mockResolvedValueOnce(snapshotReply('/move-repo', 'feature/refreshed'));
        const syncer = new ScmStatusSync();
        const sync = syncer.getSync('move-session');
        try {
            await sync.invalidateAndAwait();
            expect(syncer.getSync('move-session')).toBe(sync);

            await sync.invalidateAndAwait();
            expect(snapshotRequests()).toHaveLength(2);
            expect(published('move-session')?.branch.head).toBe('feature/refreshed');
        } finally {
            syncer.stop('move-session');
        }
    });

    it('fetches when an automatic refresh arrives before any sync was requested', async () => {
        seedRepository('auto-machine', { 'auto-session': '/auto-repo' });
        machineRpc.mockResolvedValue(snapshotReply('/auto-repo'));
        const syncer = new ScmStatusSync();
        try {
            syncer.invalidateFromAutoRefresh('auto-session');
            await syncer.getSync('auto-session').awaitQueue();
            expect(snapshotRequests()).toHaveLength(1);
            expect(published('auto-session')?.repo.rootPath).toBe('/auto-repo');
        } finally {
            syncer.stop('auto-session');
        }
    });

    it('refreshes the session project workspace when the session metadata no longer carries a path', async () => {
        seedRepository('project-machine', { 'project-session': '/project-repo' });
        // The project registry observed the workspace before the path left the session metadata.
        expect(storage.getState().getProjectForSession('project-session')?.key.rootPath).toBe('/project-repo');
        storage.setState({ sessions: { 'project-session': repositorySession('project-session', 'project-machine', '') } });
        machineRpc.mockResolvedValue(snapshotReply('/project-repo'));
        const syncer = new ScmStatusSync();
        try {
            syncer.invalidateFromAutoRefresh('project-session');
            await syncer.getSync('project-session').awaitQueue();
            expect(snapshotRequests()).toHaveLength(1);
            expect(snapshotRequests()[0]?.[0]).toMatchObject({ machineId: 'project-machine', payload: expect.objectContaining({ cwd: '/project-repo' }) });
        } finally {
            syncer.stop('project-session');
        }
    });

    it('rate limits automatic refreshes per project without holding user refreshes', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        seedRepository('rate-machine', { 'rate-session': '/rate-repo' });
        machineRpc.mockResolvedValue(snapshotReply('/rate-repo'));
        const syncer = new ScmStatusSync();
        const autoRefresh = async () => {
            syncer.invalidateFromAutoRefresh('rate-session');
            await syncer.getSync('rate-session').awaitQueue();
        };
        try {
            await autoRefresh();
            expect(snapshotRequests()).toHaveLength(1);

            now.mockReturnValue(1_000_000 + 29_999);
            await autoRefresh();
            expect(snapshotRequests()).toHaveLength(1);

            await syncer.invalidateFromUserAndAwait('rate-session');
            expect(snapshotRequests()).toHaveLength(2);

            // The automatic lease spans one interval; it is not a one-shot.
            now.mockReturnValue(1_000_000 + 30_000);
            await autoRefresh();
            expect(snapshotRequests()).toHaveLength(3);
        } finally {
            syncer.stop('rate-session');
        }
    });

    it.each([
        ['an automatic refresh past its interval', (syncer: ScmStatusSync, sessionId: string) => syncer.invalidateFromAutoRefresh(sessionId)],
        ['a workspace mutation', (syncer: ScmStatusSync, sessionId: string) => syncer.invalidateFromMutation(sessionId)],
    ])('keeps an unsupported repository suspended against %s until the user refreshes', async (label, invalidate) => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
        const id = `unsupported-${label.split(' ').at(-1)}`;
        seedRepository(`${id}-machine`, { [id]: `/${id}-repo` });
        machineRpc
            .mockResolvedValueOnce({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'RPC method not available' })
            .mockResolvedValue(snapshotReply(`/${id}-repo`));
        const syncer = new ScmStatusSync();
        try {
            syncer.invalidateFromAutoRefresh(id);
            await syncer.getSync(id).awaitQueue();
            expect(storage.getState().getSessionProjectScmSnapshotError(id)).toMatchObject({
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, message: 'RPC method not available',
            });

            // Past the automatic-refresh interval, only the suspension can hold this invalidation.
            now.mockReturnValue(2_000_000 + 300_000);
            invalidate(syncer, id);
            await syncer.getSync(id).awaitQueue();
            expect(snapshotRequests()).toHaveLength(1);

            await syncer.invalidateFromUserAndAwait(id);
            expect(snapshotRequests()).toHaveLength(2);
            expect(storage.getState().getSessionProjectScmSnapshotError(id)).toBeNull();
            expect(published(id)?.repo.rootPath).toBe(`/${id}-repo`);
        } finally {
            syncer.stop(id);
        }
    });
});
