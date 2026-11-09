import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

// React Native and its styling layer are the platform boundary; the store, its row writers,
// the source owner and the visible list projection stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');

const SESSIONS = 1_000;
const NOW_MS = 1_700_000_000_000;
const initialState = storage.getState();

function sessionIds(index: ReadonlyArray<SessionListIndexItem> | null | undefined): string[] {
    return (index ?? []).flatMap(item => item.type === 'session' ? [`${item.groupKind ?? ''}:${item.sessionId}`] : []);
}

describe('visible Session list index cost per row write at a thousand Sessions', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
        vi.useRealTimers();
    });

    it('re-derives only the written row and re-reads no listed row for an unlisted change', { timeout: 120_000 }, async () => {
        const previousStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 80;
        const serverId = getActiveServerSnapshot().serverId;
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'recent_activity' });
        const sessions: Session[] = Array.from({ length: SESSIONS }, (_, index) => createSessionFixture({
            id: `scale-${index}`, serverId, active: false, presence: 0, seq: 1, lastViewedSessionSeq: 1,
            createdAt: NOW_MS - 2_000_000_000 + index, updatedAt: NOW_MS - 2_000_000_000 + index,
            activeAt: NOW_MS - 2_000_000_000 + index, meaningfulActivityAt: NOW_MS - 2_000_000_000 + index * 60_000,
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), { source: 'ordinary', mode: 'replace' });

        // Two counts, attributed by stack to this hook: row lookups in the row map, and rows whose
        // runtime/status facts were derived (`thinkingAt` is read once per derivation).
        let rowLookups = 0;
        const derived = new Set<string>();
        const fromList = () => /useVisibleSessionListViewState\.ts:/.test(new Error().stack ?? '');
        const countRow = (row: SessionListRenderableSession): SessionListRenderableSession => new Proxy(row, { get(target, key, receiver) {
            if (key === 'thinkingAt' && fromList()) derived.add(target.id);
            return Reflect.get(target, key, receiver);
        } });
        const countLookups = <T extends object>(values: T): T => new Proxy(values, { get(target, key, receiver) {
            if (typeof key === 'string' && key.startsWith('scale-') && fromList()) rowLookups += 1;
            return Reflect.get(target, key, receiver);
        } });
        const seeded = storage.getState();
        storage.setState({ sessionListRowsByServerId: { ...seeded.sessionListRowsByServerId, [serverId]: countLookups(Object.fromEntries(
            Object.entries(seeded.sessionListRowsByServerId[serverId]!).map(([id, row]) => [id, countRow(row)]))) } });

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const first = hook.getCurrent().visibleSessionListIndex;
        expect(sessionIds(first)).toHaveLength(SESSIONS);

        const reset = () => { rowLookups = 0; derived.clear(); };
        // The canonical row writer's publication for one changed row whose list placement is unchanged
        // (the same delta shape `applySessions` publishes; this layout's index does not change).
        const writeRowInPlace = async (session: Session) => {
            const state = storage.getState();
            const bucket = state.sessionListRowsByServerId[serverId]!;
            reset();
            await act(async () => storage.setState({
                sessions: { ...state.sessions, [session.id]: session },
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [serverId]: countLookups({ ...bucket,
                    [session.id]: countRow(buildSessionListRenderableFromSession(session, bucket[session.id])) }) },
                sessionListRenderableDelta: { revision: state.sessionListRenderableDelta.revision + 1, changedSessionIds: [session.id],
                    removedSessionIds: [], rebuiltSessionListIndex: false, ordinaryMembershipChanges: [] },
            }));
            await flushHookEffects();
        };

        try {
            // A write to a row outside the listed corpus.
            const outside = createSessionFixture({ id: 'scale-outside', serverId, active: false, presence: 0, seq: 1 });
            await writeRowInPlace(outside);
            expect({ rowLookups, derived: derived.size }).toEqual({ rowLookups: 0, derived: 0 });
            expect(hook.getCurrent().visibleSessionListIndex).toBe(first);

            // A listed row's content changes (a new seq), its placement does not.
            await writeRowInPlace({ ...storage.getState().sessions['scale-500']!, seq: 2 });
            expect([...derived]).toEqual(['scale-500']);
            expect(hook.getCurrent().visibleSessionListIndex).toBe(first);

            // A listed row moves to the top: the canonical writer rebuilds the store index.
            reset();
            await act(async () => storage.getState().applySessions([{ ...storage.getState().sessions['scale-3']!, seq: 3,
                updatedAt: NOW_MS, activeAt: NOW_MS, meaningfulActivityAt: NOW_MS }]));
            await flushHookEffects();
            // Only the written row (a fresh, uncounted object) is derived again; every retained row is reused.
            expect(derived.size).toBe(0);
            const moved = hook.getCurrent().visibleSessionListIndex;
            expect(sessionIds(moved)[0]).toBe(sessionIds(moved).find(id => id.endsWith(':scale-3')));
            expect(moved?.filter(item => item.type === 'session' && item.sessionId !== 'scale-3')
                .every(item => first?.includes(item))).toBe(true);

            // The incremental result is the full projection's result.
            const fresh = await renderHook(() => useVisibleSessionListViewState('all'));
            await flushHookEffects();
            expect(sessionIds(fresh.getCurrent().visibleSessionListIndex)).toEqual(sessionIds(moved));
            await fresh.unmount();
        } finally {
            Error.stackTraceLimit = previousStackLimit;
        }
    });

    it('updates single entries for one listed-row write and keeps the full projection result', { timeout: 300_000 }, async () => {
        const previousStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 40;
        const serverId = getActiveServerSnapshot().serverId;
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'recent_activity', sessionListAttentionPlacementV1: 'top' });
        const sessions: Session[] = Array.from({ length: SESSIONS }, (_, index) => createSessionFixture({
            id: `scale-${index}`, serverId, active: false, presence: 0, seq: 1, lastViewedSessionSeq: 1,
            createdAt: NOW_MS - 2_000_000_000 + index, updatedAt: NOW_MS - 2_000_000_000 + index,
            activeAt: NOW_MS - 2_000_000_000 + index, meaningfulActivityAt: NOW_MS - 2_000_000_000 + index * 60_000,
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), { source: 'ordinary', mode: 'replace' });

        // Rows each projection stage reads, by stage, attributed by stack. A stage that reads a row
        // recomputes that row's entry.
        const STAGES = {
            membership: /\bprojectWorkMembership\b/,
            projects: /\bprojectSessionListAcceptedProjects\b/,
            ordering: /\b(projectSessionListIndexForLayout|sortSessionListIndexItemsByOrderingMode|isSessionListIndexItemsAlreadyOrderedByOrderingMode)\b/,
            bands: /\bbuildSessionListGlobalPlacements\b/,
            grouping: /\b(projectWorkflowRunRows|nestSessionListReports|filterHideInactiveSessions|inspectVisibleSessionListSourceState)\b/,
        } as const;
        const read = Object.fromEntries(Object.keys(STAGES).map(stage => [stage, new Set<string>()])) as Record<keyof typeof STAGES, Set<string>>;
        let counting = false;
        const countRow = (row: SessionListRenderableSession): SessionListRenderableSession => new Proxy(row, { get(target, key, receiver) {
            if (counting && typeof key === 'string') {
                const stack = new Error().stack ?? '';
                if (/useVisibleSessionListViewState\.ts:/.test(stack)) {
                    for (const [stage, pattern] of Object.entries(STAGES)) if (pattern.test(stack)) read[stage as keyof typeof STAGES].add(target.id);
                }
            }
            return Reflect.get(target, key, receiver);
        } });
        const seeded = storage.getState();
        storage.setState({ sessionListRowsByServerId: { ...seeded.sessionListRowsByServerId, [serverId]: Object.fromEntries(
            Object.entries(seeded.sessionListRowsByServerId[serverId]!).map(([id, row]) => [id, countRow(row)])) } });

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const writeRow = async (session: Session) => {
            const state = storage.getState();
            const bucket = state.sessionListRowsByServerId[serverId]!;
            const before = hook.getCurrent().visibleSessionListIndex ?? [];
            for (const rows of Object.values(read)) rows.clear();
            counting = true;
            await act(async () => storage.setState({
                sessions: { ...state.sessions, [session.id]: session },
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [serverId]: { ...bucket,
                    [session.id]: countRow(buildSessionListRenderableFromSession(session, bucket[session.id])) } },
                sessionListRenderableDelta: { revision: state.sessionListRenderableDelta.revision + 1, changedSessionIds: [session.id],
                    removedSessionIds: [], rebuiltSessionListIndex: false, ordinaryMembershipChanges: [] },
            }));
            await flushHookEffects();
            counting = false;
            const after = hook.getCurrent().visibleSessionListIndex ?? [];
            const previousItems = new Set(before);
            return {
                recomputed: Object.fromEntries(Object.entries(read).map(([stage, rows]) => [stage, rows.size])),
                replacedEntries: after.filter(item => !previousItems.has(item)).length,
                listKept: after === before,
            };
        };
        const expectFullProjectionResult = async () => {
            const fresh = await renderHook(() => useVisibleSessionListViewState('all'));
            await flushHookEffects();
            expect(sessionIds(fresh.getCurrent().visibleSessionListIndex)).toEqual(sessionIds(hook.getCurrent().visibleSessionListIndex));
            await fresh.unmount();
        };
        const none = { membership: 0, projects: 0, ordering: 0, bands: 0, grouping: 0 };

        try {
            // A listed row's content changes (a new seq); nothing the list arranges by changes.
            expect(await writeRow({ ...storage.getState().sessions['scale-500']!, seq: 2 }))
                .toEqual({ recomputed: { ...none, membership: 1 }, replacedEntries: 0, listKept: true });
            await expectFullProjectionResult();

            // A listed row starts working: it moves into the Working band. Membership re-admits only that row;
            // the arranging passes run once, reading each row's retained facts.
            const working = await writeRow({ ...storage.getState().sessions['scale-500']!, seq: 3, active: true, presence: 'online',
                thinking: true, thinkingAt: NOW_MS, activeAt: NOW_MS, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: NOW_MS });
            expect(working.recomputed.membership).toBe(1);
            expect(working.listKept).toBe(false);
            expect(hook.getCurrent().visibleSessionListIndex?.some(item => item.type === 'session' && item.sessionId === 'scale-500'
                && item.groupKind === 'working')).toBe(true);
            await expectFullProjectionResult();
            console.log('P03LISTINDEX-MOVE', JSON.stringify(working));
        } finally {
            Error.stackTraceLimit = previousStackLimit;
        }
    });
});
