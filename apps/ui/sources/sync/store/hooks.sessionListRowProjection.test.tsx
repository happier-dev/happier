import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import * as rowLookup from '@/sync/domains/session/listing/sessionListRowStateLookup';
import renderer, { act } from 'react-test-renderer';
import * as linkedSessionMetadata from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { t } from '@/text';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRuntimePriorityRowKeys, resolveSessionListRuntimePriorityRowNextFreshnessAtMs } from '@/sync/domains/session/listing/sessionListRuntimePriorityRows';
import {
    buildSessionListRowScopeKey,
    buildSessionListServerScopedRowKey,
} from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { storage } from '@/sync/domains/state/storageStore';
import {
    useSessionListRenderableWithServerScope,
    useSessionListRowRenderablesForItems,
    useSessionListReachabilityRenderablesForItems,
    useSessionListRowsByServerId,
    useSessionListRuntimePriorityRowKeysForItems,
    useSessionForkSupportSource,
} from './hooks';

function buildActiveRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session-list-row-projection',
        seq: 10,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 5_000,
        meaningfulActivityAt: Date.now() - 5_000,
        active: true,
        activeAt: Date.now() - 5_000,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/tmp/session-list-row-projection', host: 'localhost' },
        thinking: true,
        thinkingAt: Date.now() - 5_000,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: Date.now() - 5_000,
        hasUnreadMessages: true,
        ...overrides,
    };
}

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('useSessionListRenderableWithServerScope row projection', () => {
    it.each(['delete Sessions', 'retire Home'] as const)('releases full rows and fork metadata after %s', async (lifecycle) => {
        const { Session: InspectorSession } = await import('node:inspector');
        const previous = storage.getState();
        // Also restore if initial hook acquisition throws before the inspector exists.
        onTestFinished(() => storage.setState(previous));
        const serverId = `retention-${lifecycle}`;
        const count = lifecycle === 'retire Home' ? 1_000 : 32;
        const ids = Array.from({ length: count }, (_, index) => `retired-${index}`);
        const survivingHome = `${serverId}-survivor`;
        const items: SessionListIndexItem[] = ids.map(sessionId => ({ type: 'session', serverId, sessionId }));
        const retained = (() => {
            const rows = ids.map(id => buildActiveRenderable({ id, metadata: {
                path: `/workspace/${id}`, host: 'host', summaryText: 'retired data '.repeat(128),
            } }));
            storage.setState({ sessionListRowsByServerId: {
                [serverId]: Object.fromEntries(rows.map(row => [row.id, row])),
                [survivingHome]: { [ids[0]!]: buildActiveRenderable({ id: ids[0]! }) },
            } });
            return rows.flatMap(row => [new WeakRef<object>(row), new WeakRef<object>(row.metadata!)]);
        })();
        const hook = await renderHook(() => {
            const bulk = useSessionListRowRenderablesForItems(items);
            const survivor = {
                row: useSessionListRenderableWithServerScope(survivingHome, ids[0]!),
                fork: useSessionForkSupportSource(ids[0]!, survivingHome),
            };
            // This scale fixture has a fixed hook order throughout its lifetime.
            const remaining = ids.reduce((total, id) => {
                const row = useSessionListRenderableWithServerScope(serverId, id);
                const fork = useSessionForkSupportSource(id, serverId);
                return total + Number(Boolean(row || fork));
            }, 0);
            return { remaining, bulkCount: bulk.size, survivor };
        });
        const inspector = new InspectorSession();
        inspector.connect();
        try {
            expect(hook.getCurrent()).toMatchObject({ remaining: count, bulkCount: count });
            const survivor = hook.getCurrent().survivor;
            await act(async () => {
                if (lifecycle === 'retire Home') storage.getState().clearSessionListRowsForServerScope(serverId);
                else for (const id of ids) storage.getState().deleteSession(id, serverId);
            });
            expect(hook.getCurrent()).toMatchObject({ remaining: 0, bulkCount: 0 });
            expect(hook.getCurrent().survivor.row).toBe(survivor.row);
            expect(hook.getCurrent().survivor.fork).toBe(survivor.fork);
            // React may keep the previous selector snapshot until unmount.
            await hook.unmount();
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage',
                error => error ? reject(error) : resolve()));
            expect(retained.filter(reference => reference.deref() !== undefined).length,
                'no removed full rows or fork metadata may remain rooted by projections').toBe(0);
        } finally {
            inspector.disconnect();
            await hook.unmount();
        }
    });

    it('does not revisit Session row readers for Machine-only notifications', async () => {
        const previous = storage.getState();
        const serverId = 'machine-notification-home';
        const rows = Array.from({ length: 50 }, (_, i) => buildActiveRenderable({ id: `row-${i}` }));
        const items: SessionListIndexItem[] = rows.map(row => ({ type: 'session', serverId, sessionId: row.id }));
        storage.setState({ sessionListRowsByServerId: { [serverId]: Object.fromEntries(rows.map(row => [row.id, row])) } });
        const hook = await renderHook(() => useSessionListReachabilityRenderablesForItems(items));
        const read = vi.spyOn(rowLookup, 'readSessionListRowForServerId');
        try {
            await act(async () => { storage.setState(state => ({ machineDisplayById: { ...state.machineDisplayById } })); });
            expect(hook.getCurrent().size).toBe(50);
            expect(read).not.toHaveBeenCalled();
        } finally { read.mockRestore(); await hook.unmount(); storage.setState(previous); }
    });

    it('projects the canonical workspace path and managed-directory display facts', async () => {
        const previous = storage.getState();
        const serverId = 'workspace-display-home';
        const row = buildActiveRenderable({ metadata: {
            machineId: 'workspace-machine', path: '/home/alice/work/repo', homeDir: '/home/alice', host: 'host',
        } });
        const items: SessionListIndexItem[] = [{ type: 'session', serverId, sessionId: row.id }];
        storage.setState({ sessionListRowsByServerId: { [serverId]: { [row.id]: row } } });
        const hook = await renderHook(() => useSessionListReachabilityRenderablesForItems(items));
        const display = () => resolveSessionWorkspaceDisplayPresentation({ serverId,
            metadata: [...hook.getCurrent().values()][0]?.metadata, workspaceRefs: [], workspacePathDisplayModeV1: 'path' });
        try {
            expect(display()).toMatchObject({ directoryKind: 'path', displayTitle: '~/work/repo',
                workspaceScope: { serverId, machineId: 'workspace-machine', rootPath: '/home/alice/work/repo' } });
            await act(async () => { storage.setState({ sessionListRowsByServerId: { [serverId]: { [row.id]: {
                ...row, metadata: { ...row.metadata!, sessionDirectoryV1: { v: 1, kind: 'managed' } },
            } } } }); });
            expect(display()).toMatchObject({ directoryKind: 'managed', displayTitle: t('session.folderless.privateToSession'), workspaceScope: null });
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('releases superseded metadata while retaining the unchanged reachability projection', async () => {
        const { Session: InspectorSession } = await import('node:inspector');
        const previous = storage.getState();
        const serverId = 'reachability-metadata-retention-home';
        const sessionId = 'reachability-metadata-retention-session';
        const items: SessionListIndexItem[] = [{ type: 'session', serverId, sessionId }];
        const superseded = (() => {
            const metadata = { path: '/workspace', host: 'host', summaryText: 'private summary '.repeat(1024) };
            storage.setState({ sessionListRowsByServerId: {
                [serverId]: { [sessionId]: buildActiveRenderable({ id: sessionId, metadata }) },
            } });
            return new WeakRef(metadata);
        })();
        const hook = await renderHook(() => useSessionListReachabilityRenderablesForItems(items));
        const inspector = new InspectorSession();
        inspector.connect();
        try {
            const first = [...hook.getCurrent().values()][0];
            expect(first?.metadata).toMatchObject({ path: '/workspace', host: 'host' });
            await act(async () => {
                storage.setState({ sessionListRowsByServerId: {
                    [serverId]: { [sessionId]: buildActiveRenderable({ id: sessionId,
                        metadata: { path: '/workspace', host: 'host', summaryText: 'replacement' } }) },
                } });
            });
            expect([...hook.getCurrent().values()][0]).toBe(first);
            // Drop React's prior selector snapshots as well as the store row.
            // Only the reachability owner should retain its compact projection.
            await hook.unmount();
            storage.setState(previous);
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage',
                error => error ? reject(error) : resolve()));
            expect(superseded.deref() === undefined, 'reachability must not retain the full superseded metadata').toBe(true);
        } finally {
            inspector.disconnect();
            await hook.unmount();
            storage.setState(previous);
        }
    });

    it('updates reachability fields and unreadability independently for the same Session id on two Homes', async () => {
        const previous = storage.getState();
        const sessionId = 'reachability-owner-fields';
        const row = buildActiveRenderable({ id: sessionId, metadata: { path: '/first', host: 'host' } });
        storage.setState({ sessionListRowsByServerId: { 'reach-home-a': { [sessionId]: row }, 'reach-home-b': { [sessionId]: row } } });
        const items: SessionListIndexItem[] = ['reach-home-a', 'reach-home-b'].map(serverId => ({ type: 'session', serverId, sessionId }));
        const hook = await renderHook(() => useSessionListReachabilityRenderablesForItems(items));
        try {
            const first = [...hook.getCurrent().values()];
            await act(async () => { storage.setState({ sessionListRowsByServerId: {
                'reach-home-a': { [sessionId]: { ...row, metadata: { path: '/moved', host: 'host' } } },
                'reach-home-b': { [sessionId]: row },
            } }); });
            const moved = [...hook.getCurrent().values()];
            expect(moved[0]?.metadata?.path).toBe('/moved');
            expect(moved[0]).not.toBe(first[0]);
            expect(moved[1]).toBe(first[1]);
            await act(async () => { storage.setState({ sessionListRowsByServerId: {
                'reach-home-a': { [sessionId]: { ...row, metadata: null } },
                'reach-home-b': { [sessionId]: row },
            } }); });
            expect([...hook.getCurrent().values()][0]?.metadata).toBeNull();
            expect([...hook.getCurrent().values()][1]).toBe(first[1]);
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('does not reacquire the profile resolver per row on unchanged multi-Home store notifications', async () => {
        const previous = storage.getState();
        const previousProfiles = serverProfiles.listServerProfiles();
        const previousActive = serverProfiles.getActiveServerSnapshot().serverId;
        await seedPersistedHomeProfilesForTests({ activeServerId: 'home-b', profiles: ['a', 'b'].map(id => ({
            id: `home-${id}`, ...(id === 'b' ? { serverIdentityId: 'srv_home_b' } : {}), name: id,
            serverUrl: `https://home-${id}.example.test`, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        })) });
        const rows = Array.from({ length: 50 }, (_, index) => buildActiveRenderable({ id: `same-${index}`, active: false, thinking: false }));
        const byId = Object.fromEntries(rows.map(row => [row.id, row]));
        storage.setState({ sessionListRowsByServerId: { 'home-a': byId, srv_home_b: byId },
            sessionArchiveOperations: { 'home-a': { 'same-0': { serverId: 'home-a', sessionId: 'same-0' } } } });
        const items: SessionListIndexItem[] = ['home-a', 'home-b'].flatMap(serverId => rows.map(row => ({ type: 'session', serverId, sessionId: row.id })));
        const hook = await renderHook(() => ({ rows: useSessionListRowRenderablesForItems(items),
            reachability: useSessionListReachabilityRenderablesForItems(items),
            mounted: useSessionListRenderableWithServerScope('home-a', 'same-0') }));
        try {
            expect(hook.getCurrent().rows.size).toBe(100);
            expect(hook.getCurrent().reachability.size).toBe(100);
            expect(hook.getCurrent().mounted).toMatchObject({ id: 'same-0', archiving: true });
            const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
            const capture = vi.spyOn(serverProfiles, 'captureServerProfileScopeResolver');
            try {
                for (let index = 0; index < 3; index++) await act(async () => {
                    storage.setState(state => ({ isDataReady: !state.isDataReady }));
                });
                expect(resolve).not.toHaveBeenCalled();
                expect(capture).not.toHaveBeenCalled();
            } finally { resolve.mockRestore(); capture.mockRestore(); }
            // A real profile publication is seen by the next operation, not
            // hidden behind a resolver retained by a mounted selector.
            await act(async () => { await serverProfiles.setServerProfileIdentityForUrl('https://home-a.example.test', 'srv_home_a'); });
            await act(async () => { storage.setState(state => ({ isDataReady: !state.isDataReady,
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, srv_home_a: {} } })); });
            expect(hook.getCurrent().rows.size).toBe(50);
            expect(hook.getCurrent().reachability.size).toBe(50);
            expect(hook.getCurrent().mounted).toBeNull();
        } finally {
            await hook.unmount(); storage.setState(previous);
            await seedPersistedHomeProfilesForTests({ profiles: previousProfiles, activeServerId: previousActive });
        }
    });
    it('does not encode an unchanged mounted row address on unrelated store publications', async () => {
        const previous = storage.getState();
        const sessionId = 'same:session';
        const home = 'home:one';
        const otherHome = 'home';
        const row = buildActiveRenderable({ id: sessionId, active: false, thinking: false });
        const otherRow = { ...row, seq: row.seq + 100 };
        storage.setState({ sessionListRowsByServerId: {
            [home]: { [sessionId]: row },
            [otherHome]: { [sessionId]: otherRow },
        } });
        const hook = await renderHook(
            ({ serverId }: { serverId: string }) => useSessionListRenderableWithServerScope(serverId, sessionId),
            { initialProps: { serverId: home } },
        );
        try {
            const first = hook.getCurrent();
            const encode = vi.spyOn(JSON, 'stringify');
            const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
            const capture = vi.spyOn(serverProfiles, 'captureServerProfileScopeResolver');
            let encodes: number;
            try {
                for (let index = 0; index < 20; index++) {
                    await act(async () => { storage.setState(state => ({ isDataReady: !state.isDataReady })); });
                    expect(hook.getCurrent()).toBe(first);
                }
                expect(resolve).not.toHaveBeenCalled();
                expect(capture).not.toHaveBeenCalled();
                await hook.rerender({ serverId: home });
                expect(hook.getCurrent()).toBe(first);
                encodes = encode.mock.calls.filter(([value]) => Array.isArray(value)
                    && value[0] === home && value[1] === sessionId).length;
            } finally { encode.mockRestore(); resolve.mockRestore(); capture.mockRestore(); }
            expect(encodes).toBe(0);
            await hook.rerender({ serverId: otherHome });
            expect(hook.getCurrent()?.seq).toBe(otherRow.seq);
            await hook.rerender({ serverId: home });
            expect(hook.getCurrent()).toBe(first);
        } finally {
            await hook.unmount();
            storage.setState(previous);
        }
    });

    it('keeps allocating row selectors stable between real inputs, including pending archive progress', async () => {
        const previous = storage.getState();
        const address = { serverId: 'allocating-selector-home', sessionId: 'allocating-selector-row' };
        const row = buildActiveRenderable({ id: address.sessionId });
        storage.setState({ sessionArchiveOperations: {}, sessionListRowsByServerId: {
            [address.serverId]: { [row.id]: row }, 'other-home': { [row.id]: row },
        } });
        let selections = 0;
        let renders = 0;
        const select = (rows: ReturnType<typeof storage.getState>['sessionListRowsByServerId']) => {
            selections += 1;
            return { homes: Object.entries(rows).map(([serverId, bucket]) => ({ serverId, rows: Object.values(bucket) })),
                byId: new Map(Object.values(rows).flatMap(bucket => Object.values(bucket).map(value => [value.id, value] as const))) };
        };
        const alternate = (_rows: ReturnType<typeof storage.getState>['sessionListRowsByServerId']): ReturnType<typeof select> => ({ homes: [], byId: new Map() });
        const hook = await renderHook((mode: 'rows' | 'empty' | 'alternate') => {
            renders += 1;
            return useSessionListRowsByServerId(mode === 'empty' ? [] : [address.serverId], mode === 'alternate' ? alternate : select);
        }, { initialProps: 'rows' });
        let operation: ReturnType<ReturnType<typeof storage.getState>['beginSessionArchive']> = null;
        try {
            const initial = hook.getCurrent();
            expect(initial.byId.get(row.id)).toBe(row);
            const initialSelections = selections;
            await act(async () => { storage.setState(state => ({ isDataReady: !state.isDataReady })); });
            await hook.rerender();
            expect(hook.getCurrent()).toBe(initial);
            expect(selections).toBe(initialSelections);
            await act(async () => { operation = storage.getState().beginSessionArchive(address); });
            const pending = hook.getCurrent();
            expect(pending).not.toBe(initial);
            expect(pending.byId.get(row.id)).toMatchObject({ archiving: true, keepVisibleWhenInactive: true });
            const pendingSelections = selections;
            const pendingRenders = renders;
            await act(async () => {
                const other = storage.getState().beginSessionArchive({ ...address, serverId: 'other-home' });
                if (other) storage.getState().finishSessionArchive(other);
            });
            expect(hook.getCurrent()).toBe(pending);
            expect(selections).toBe(pendingSelections);
            expect(renders).toBe(pendingRenders);
            await act(async () => { if (operation) storage.getState().finishSessionArchive(operation); });
            expect(hook.getCurrent().byId.get(row.id)).toBe(row);
            const changed = { ...row, metadata: { ...row.metadata!, summaryText: 'Changed' } };
            await act(async () => { storage.setState({ sessionListRowsByServerId: { [address.serverId]: { [row.id]: changed } } }); });
            expect(hook.getCurrent().byId.get(row.id)).toBe(changed);
            expect((await hook.rerender('alternate')).byId.size).toBe(0);
            expect((await hook.rerender('rows')).byId.get(row.id)).toBe(changed);
            expect((await hook.rerender('empty')).homes).toEqual([]);
            expect((await hook.rerender('rows')).byId.get(row.id)).toBe(changed);
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('projects shared archive progress locally without changing unrelated Home rows or attention flags', async () => {
        const previous = storage.getState();
        const address = { serverId: 'archive-projection-home', sessionId: 'archive-projection-session' };
        const unrelated = buildActiveRenderable({ id: 'unrelated-row', keepVisibleWhenInactive: true });
        const row = buildActiveRenderable({ id: address.sessionId, active: false, thinking: false });
        storage.setState({ sessionArchiveOperations: {}, sessionListRowsByServerId: {
            [address.serverId]: { [row.id]: row, [unrelated.id]: unrelated },
            'other-home': { [row.id]: row },
        } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionListRowsByServerId([address.serverId]);
        });
        let operation: ReturnType<ReturnType<typeof storage.getState>['beginSessionArchive']> = null;
        try {
            await act(async () => { operation = storage.getState().beginSessionArchive(address); });
            const projected = hook.getCurrent();
            expect(projected[address.serverId]?.[row.id]).toMatchObject({ archiving: true, keepVisibleWhenInactive: true });
            expect(projected[address.serverId]?.[unrelated.id]).toBe(unrelated);
            expect(storage.getState().sessionListRowsByServerId[address.serverId]?.[row.id]).toBe(row);
            const count = renders;
            await act(async () => {
                const other = storage.getState().beginSessionArchive({ ...address, serverId: 'other-home' });
                if (other) storage.getState().finishSessionArchive(other);
            });
            expect(renders).toBe(count);
            expect(hook.getCurrent()).toBe(projected);
            await act(async () => { if (operation) storage.getState().finishSessionArchive(operation); });
            expect(hook.getCurrent()[address.serverId]?.[row.id]).toBe(row);
            expect(hook.getCurrent()[address.serverId]?.[unrelated.id]).toBe(unrelated);
        } finally {
            await hook.unmount();
            storage.setState(previous);
        }
    });

    it('keeps the projected renderable stable when fresh progress also advances active heartbeat', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-fresh-heartbeat';
        const serverId = 'server-a';
        const firstRenderable = buildActiveRenderable({ id: sessionId });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: {
                        ...(state.sessionListRowsByServerId[serverId] ?? {}),
                        [sessionId]: firstRenderable,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: [sessionId],
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(serverId, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const freshProgressRenderable = {
                ...firstRenderable,
                seq: firstRenderable.seq + 1,
                updatedAt: firstRenderable.updatedAt + 5_000,
                meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
                activeAt: firstRenderable.activeAt + 5_000,
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            ...state.sessionListRowsByServerId[serverId],
                            [sessionId]: freshProgressRenderable,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(firstProjection);

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('keeps the projected renderable when a turn bumps only document versions alongside fresh progress (P03 Q16)', async () => {
        // A running Session's agent-state/metadata documents re-version every turn phase while the row's
        // projected content (versions zeroed) stays the same: the row must not redraw for them.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-version-bump';
        const serverId = 'server-a';
        const firstRenderable = buildActiveRenderable({ id: sessionId });
        const publish = (renderable: SessionListRenderableSession) => storage.setState((state) => ({
            ...state,
            isDataReady: true,
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [serverId]: { ...(state.sessionListRowsByServerId[serverId] ?? {}), [sessionId]: renderable },
            },
            ordinarySessionListMembershipByServerId: { ...state.ordinarySessionListMembershipByServerId, [serverId]: [sessionId] },
        }));
        try {
            publish(firstRenderable);
            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(serverId, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const projections = new Set([hook.getCurrent()]);
            let current = firstRenderable;
            for (let step = 1; step <= 3; step += 1) {
                current = {
                    ...current,
                    seq: current.seq + 1,
                    updatedAt: current.updatedAt + 1_000,
                    meaningfulActivityAt: (current.meaningfulActivityAt ?? current.updatedAt) + 1_000,
                    agentStateVersion: current.agentStateVersion + 1,
                    metadataVersion: current.metadataVersion + 1,
                    metadata: { ...current.metadata! },
                };
                await act(async () => { publish(current); });
                projections.add(hook.getCurrent());
            }
            expect(projections.size).toBe(1);
            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('refreshes the projected renderable when the previous active heartbeat is near stale', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-stale-heartbeat';
        const serverId = 'server-a';
        const firstRenderable = buildActiveRenderable({
            id: sessionId,
            activeAt: Date.now() - 119_000,
            latestTurnStatusObservedAt: Date.now() - 119_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: {
                        ...(state.sessionListRowsByServerId[serverId] ?? {}),
                        [sessionId]: firstRenderable,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: [sessionId],
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(serverId, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const heartbeatRefreshRenderable = {
                ...firstRenderable,
                seq: firstRenderable.seq + 1,
                updatedAt: firstRenderable.updatedAt + 5_000,
                meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
                activeAt: Date.now(),
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            ...state.sessionListRowsByServerId[serverId],
                            [sessionId]: heartbeatRefreshRenderable,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstProjection);
            expect(hook.getCurrent()?.seq).toBe(heartbeatRefreshRenderable.seq);

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('refreshes the projected renderable for runtime activity revision changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-runtime-revision';
        const serverId = 'server-a';
        const firstRenderable = buildActiveRenderable({
            id: sessionId,
            active: false,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
            runtimeActivityRevision: 1,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: {
                        ...(state.sessionListRowsByServerId[serverId] ?? {}),
                        [sessionId]: firstRenderable,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: [sessionId],
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(serverId, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const revisionOnlyRenderable = {
                ...firstRenderable,
                runtimeActivityObservedAt: now + 30_000,
                runtimeActivityRevision: 2,
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            ...state.sessionListRowsByServerId[serverId],
                            [sessionId]: revisionOnlyRenderable,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstProjection);
            expect(hook.getCurrent()).toMatchObject({
                runtimeActivityObservedAt: now + 30_000,
                runtimeActivityRevision: 2,
            });

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });
});

describe('buildSessionListRuntimePriorityRowKeys', () => {
    it('does not use provider runtime activity as row-priority proof', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime' },
            { type: 'session', serverId: 'server-a', sessionId: 'stale-runtime' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const baseRenderable = buildActiveRenderable({
            active: false,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
        });

        const keys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                'fresh-runtime': {
                    ...baseRenderable,
                    id: 'fresh-runtime',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                    runtimeActivityRevision: now + 60_000,
                },
                'stale-runtime': {
                    ...baseRenderable,
                    id: 'stale-runtime',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 300_000,
                    runtimeActivityRevision: now - 1,
                },
            },
        });

        expect(keys).toEqual(new Set());
    });

    it('expires stale raw thinking while retaining the canonical in-progress turn projection as priority proof', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'stale-thinking' },
            { type: 'session', serverId: 'server-a', sessionId: 'stale-in-progress' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const baseRenderable = buildActiveRenderable({
            active: false,
            activeAt: now - 300_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: null,
        });

        const keys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                'stale-thinking': {
                    ...baseRenderable,
                    id: 'stale-thinking',
                    thinking: true,
                    thinkingAt: now - 300_000,
                },
                'stale-in-progress': {
                    ...baseRenderable,
                    id: 'stale-in-progress',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 300_000,
                },
            },
        });

        expect(keys).toEqual(new Set([buildSessionListRowScopeKey('server-a', 'stale-in-progress')]));
    });

    it('ignores unread-only row overlay updates when selecting runtime-priority rows', () => {
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 'unread-only' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const activeRenderable = buildActiveRenderable({
            id: 'active',
            active: true,
            thinking: false,
            latestTurnStatus: null,
        });
        const unreadRenderable = buildActiveRenderable({
            id: 'unread-only',
            active: false,
            thinking: false,
            latestTurnStatus: null,
            latestReadyEventSeq: 1,
            latestReadyEventAt: 1_000,
            hasUnreadMessages: true,
        });

        const firstKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': unreadRenderable,
            },
        });
        expect(firstKeys).toEqual(new Set([buildSessionListRowScopeKey('server-a', 'active')]));

        const unreadOnlyUpdatedKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': {
                    ...unreadRenderable,
                    latestReadyEventSeq: 2,
                    latestReadyEventAt: 2_000,
                    hasUnreadMessages: true,
                },
            },
        });
        expect(unreadOnlyUpdatedKeys).toEqual(firstKeys);

        const activeUnreadKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': {
                    ...unreadRenderable,
                    active: true,
                    latestReadyEventSeq: 3,
                    latestReadyEventAt: 3_000,
                },
            },
        });
        expect(activeUnreadKeys).toEqual(new Set([
            buildSessionListRowScopeKey('server-a', 'active'),
            buildSessionListRowScopeKey('server-a', 'unread-only'),
        ]));
    });
});

/**
 * Lane 07 R18 / 07.2 §11 measurement: the row-subscription cost of three Homes
 * with fifty rows each. Every row owns its own canonical selector, so this also
 * discriminates the intended per-row subscription from a plausible incorrect
 * implementation that subscribes to the whole server-scoped row map and
 * re-renders every loaded row for one patch. Timings are reported, never
 * asserted: no latency threshold or corpus ceiling is invented here.
 */
describe('session list row subscription cost across three Homes', () => {
    const HOME_COUNT = 3;
    const ROWS_PER_HOME = 50;

    function qualifiedRowKey(serverId: string, sessionId: string): string {
        const key = buildSessionListServerScopedRowKey(serverId, sessionId);
        if (!key) throw new Error(`Expected a qualified row key for ${serverId}/${sessionId}`);
        return key;
    }

    function buildMeasurementCorpus() {
        const rowsByServerId: Record<string, Record<string, SessionListRenderableSession>> = {};
        const membershipByServerId: Record<string, string[]> = {};
        const addresses: Array<Readonly<{ serverId: string; sessionId: string }>> = [];
        for (let home = 0; home < HOME_COUNT; home += 1) {
            const serverId = `row-subscription-home-${home}`;
            const rows: Record<string, SessionListRenderableSession> = {};
            const membership: string[] = [];
            for (let index = 0; index < ROWS_PER_HOME; index += 1) {
                const sessionId = `row-subscription-session-${home}-${index}`;
                rows[sessionId] = buildActiveRenderable({
                    id: sessionId,
                    serverId,
                    seq: index,
                    latestTurnStatus: 'in_progress',
                    metadata: { path: '/repo', host: 'localhost', externalSessionV1: {
                        v: 1, agentId: 'codex', machineId: `machine-${home}`, remoteSessionId: sessionId,
                        source: { kind: 'codexHome', home: 'user' },
                    } },
                });
                membership.push(sessionId);
                addresses.push({ serverId, sessionId });
            }
            rowsByServerId[serverId] = rows;
            membershipByServerId[serverId] = membership;
        }
        return { rowsByServerId, membershipByServerId, addresses };
    }

    it('re-renders only the patched row and keeps every unrelated Home row referentially stable', async () => {
        const previousState = storage.getState();
        const { rowsByServerId, membershipByServerId, addresses } = buildMeasurementCorpus();
        const renderCounts = new Map<string, number>();
        const latestProjection = new Map<string, SessionListRenderableSession | null>();
        const parse = vi.spyOn(linkedSessionMetadata, 'readNonAuthoritativeLinkedExternalSessionV1FromMetadata');

        function MeasuredRow(props: Readonly<{ serverId: string; sessionId: string }>) {
            const projected = useSessionListRenderableWithServerScope(props.serverId, props.sessionId);
            const key = qualifiedRowKey(props.serverId, props.sessionId);
            renderCounts.set(key, (renderCounts.get(key) ?? 0) + 1);
            latestProjection.set(key, projected);
            expect(readExternalSessionLink(projected?.metadata)?.remoteSessionId).toBe(props.sessionId);
            return null;
        }
        const expectedIdByKey = new Map(
            addresses.map((address) => [
                qualifiedRowKey(address.serverId, address.sessionId),
                address.sessionId,
            ]),
        );

        let tree: renderer.ReactTestRenderer | null = null;
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, ...rowsByServerId },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    ...membershipByServerId,
                },
            }));

            const mountStartedAt = performance.now();
            await act(async () => {
                tree = renderer.create(
                    <>
                        {addresses.map((address) => (
                            <MeasuredRow
                                key={qualifiedRowKey(address.serverId, address.sessionId)}
                                serverId={address.serverId}
                                sessionId={address.sessionId}
                            />
                        ))}
                    </>,
                );
            });
            const mountMs = performance.now() - mountStartedAt;

            expect(addresses).toHaveLength(HOME_COUNT * ROWS_PER_HOME);
            expect(renderCounts.size).toBe(addresses.length);
            expect([...renderCounts.values()].every((count) => count === 1)).toBe(true);
            const initialParses = parse.mock.calls.length;
            expect(initialParses).toBe(addresses.length);

            let unchangedPublications = 0;
            const stopUnchanged = storage.subscribe(() => { unchangedPublications += 1; });
            try {
                await act(async () => {
                    for (const [serverId, rows] of Object.entries(rowsByServerId)) {
                        storage.getState().applyServerScopedSessionListRows(serverId,
                            Object.values(rows).map((row) => ({ ...row })),
                            { source: 'rowOnly', mode: 'append' });
                    }
                });
            } finally {
                stopUnchanged();
            }
            expect(unchangedPublications).toBe(0);
            expect([...renderCounts.values()].every((count) => count === 1)).toBe(true);

            const target = addresses[HOME_COUNT * ROWS_PER_HOME - 20];
            const targetKey = qualifiedRowKey(target.serverId, target.sessionId);
            const unrelatedProjectionsBefore = new Map(
                [...latestProjection].filter(([key]) => key !== targetKey),
            );

            const patchStartedAt = performance.now();
            await act(async () => {
                storage.getState().applyServerScopedSessionListRows(target.serverId, [{
                    ...rowsByServerId[target.serverId][target.sessionId],
                    latestTurnStatus: 'completed',
                    hasUnreadMessages: false,
                }], { source: 'rowOnly', mode: 'append' });
            });
            const singlePatchMs = performance.now() - patchStartedAt;

            expect(renderCounts.get(targetKey)).toBe(2);
            expect(latestProjection.get(targetKey)).toMatchObject({
                id: target.sessionId,
                latestTurnStatus: 'completed',
            });
            const rerenderedUnrelatedKeys = [...unrelatedProjectionsBefore.keys()]
                .filter((key) => renderCounts.get(key) !== 1);
            expect(rerenderedUnrelatedKeys).toEqual([]);
            const misprojectedUnrelatedKeys = [...unrelatedProjectionsBefore]
                .filter(([key, projection]) => projection?.id !== expectedIdByKey.get(key))
                .map(([key]) => key);
            expect(misprojectedUnrelatedKeys).toEqual([]);

            const RAPID_CHANGE_COUNT = 20;
            const rapidStartedAt = performance.now();
            for (let change = 0; change < RAPID_CHANGE_COUNT; change += 1) {
                await act(async () => {
                    storage.setState((state) => ({
                        ...state,
                        sessionListRowsByServerId: {
                            ...state.sessionListRowsByServerId,
                            [target.serverId]: {
                                ...state.sessionListRowsByServerId[target.serverId],
                                [target.sessionId]: {
                                    ...rowsByServerId[target.serverId][target.sessionId],
                                    seq: 1_000 + change,
                                    latestTurnStatus: change % 2 === 0 ? 'in_progress' : 'completed',
                                },
                            },
                        },
                    }));
                });
            }
            const rapidChangeMs = performance.now() - rapidStartedAt;

            expect(renderCounts.get(targetKey)).toBe(2 + RAPID_CHANGE_COUNT);
            const rerenderedAfterRapidChanges = [...unrelatedProjectionsBefore.keys()]
                .filter((key) => renderCounts.get(key) !== 1);
            expect(rerenderedAfterRapidChanges).toEqual([]);
            expect(parse).toHaveBeenCalledTimes(initialParses);

            const totalRowRenders = [...renderCounts.values()].reduce((sum, count) => sum + count, 0);
            console.info([
                'Lane07 R18 UI row subscriptions:',
                `${HOME_COUNT} Homes x ${ROWS_PER_HOME} rows = ${addresses.length} subscribed selectors`,
                `mount ${mountMs.toFixed(1)} ms`,
                `single row patch ${singlePatchMs.toFixed(1)} ms`,
                `${RAPID_CHANGE_COUNT} rapid changes ${rapidChangeMs.toFixed(1)} ms`,
                `total row renders ${totalRowRenders}`,
                `platform ${process.platform}/${process.arch}`,
            ].join(', '));
        } finally {
            parse.mockRestore();
            if (tree) {
                const mounted = tree as renderer.ReactTestRenderer;
                await act(async () => {
                    mounted.unmount();
                });
            }
            standardCleanup();
            storage.setState(previousState);
        }
    });
});

describe('useSessionListRuntimePriorityRowKeysForItems', () => {
    it('does not rederive unchanged rows on store notifications and still refreshes expired signals', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const previousState = storage.getState();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'thinking-row' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        let runtimeReads = 0;
        const row = {
            ...buildActiveRenderable({ id: 'thinking-row', thinking: true, thinkingAt: 990_000 }),
            get latestTurnStatus() {
                runtimeReads += 1;
                return null;
            },
        } satisfies SessionListRenderableSession;
        try {
            storage.setState({ sessionListRowsByServerId: { 'server-a': { 'thinking-row': row } } });
            const hook = await renderHook(() => useSessionListRuntimePriorityRowKeysForItems(items));
            const first = hook.getCurrent();
            expect(first).toEqual(new Set([buildSessionListRowScopeKey('server-a', 'thinking-row')]));
            const initialReads = runtimeReads;
            expect(initialReads).toBeGreaterThan(0);

            await act(async () => {
                storage.setState({ sessionListRowsByServerId: { 'server-a': { 'thinking-row': row } } });
            });
            expect(hook.getCurrent()).toBe(first);
            expect(runtimeReads).toBe(initialReads);

            const deadline = resolveSessionListRuntimePriorityRowNextFreshnessAtMs(row, Date.now());
            expect(deadline).not.toBeNull();
            await act(async () => { await vi.advanceTimersByTimeAsync(deadline! - Date.now() + 1); });
            expect(hook.getCurrent()).toEqual(first);
            expect(runtimeReads).toBeGreaterThan(initialReads);
            await act(async () => {
                storage.setState({ sessionListRowsByServerId: { 'server-a': {
                    'thinking-row': { ...row, active: false, thinking: false },
                } } });
            });
            expect(hook.getCurrent()).toEqual(new Set());
            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('promotes canonical online runtime activity and removes the priority when it becomes idle', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const previousState = storage.getState();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'runtime-active' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        try {
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    'server-a': {
                        ...(state.sessionListRowsByServerId['server-a'] ?? {}),
                        'runtime-active': buildActiveRenderable({
                            id: 'runtime-active',
                            active: false,
                            thinking: false,
                            presence: 'online',
                            latestTurnStatus: 'completed',
                            latestTurnStatusObservedAt: 990_000,
                            runtimeActivityState: 'active',
                            runtimeActivityActiveCount: 1,
                            runtimeActivityObservedAt: 999_000,
                            runtimeActivityRevision: 1,
                        }),
                    },
                },
            }));

            const hook = await renderHook(() => useSessionListRuntimePriorityRowKeysForItems(items));

            expect(hook.getCurrent()).toEqual(new Set([
                buildSessionListRowScopeKey('server-a', 'runtime-active'),
            ]));

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-a': {
                            ...(state.sessionListRowsByServerId['server-a'] ?? {}),
                            'runtime-active': buildActiveRenderable({
                                id: 'runtime-active',
                                active: false,
                                thinking: false,
                                presence: 'online',
                                latestTurnStatus: 'completed',
                                latestTurnStatusObservedAt: 990_000,
                                runtimeActivityState: 'idle',
                                runtimeActivityActiveCount: 0,
                                runtimeActivityObservedAt: 1_000_000,
                                runtimeActivityRevision: 2,
                            }),
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toEqual(new Set());
            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('skips runtime-priority row work while disabled and restores the current priority when enabled', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const previousState = storage.getState();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'runtime-active' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        try {
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    'server-a': {
                        ...(state.sessionListRowsByServerId['server-a'] ?? {}),
                        'runtime-active': buildActiveRenderable({
                            id: 'runtime-active',
                            active: false,
                            thinking: false,
                            presence: 'online',
                            latestTurnStatus: 'completed',
                            latestTurnStatusObservedAt: 990_000,
                            runtimeActivityState: 'active',
                            runtimeActivityActiveCount: 1,
                            runtimeActivityObservedAt: 999_000,
                            runtimeActivityRevision: 1,
                        }),
                    },
                },
            }));

            const hook = await renderHook(
                ({ enabled }: { enabled: boolean }) => useSessionListRuntimePriorityRowKeysForItems(items, { enabled }),
                { initialProps: { enabled: false } },
            );

            expect(hook.getCurrent()).toEqual(new Set());

            await hook.rerender({ enabled: true });

            expect(hook.getCurrent()).toEqual(new Set([
                buildSessionListRowScopeKey('server-a', 'runtime-active'),
            ]));
            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

});
