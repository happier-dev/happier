/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1} from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionListQuerySourceHarness, waitForSessionListQueryState } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { useBoardMembership } from './useBoardContent';
import { invalidateSessionListQueryHome } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SESSION_LIST_PAGE_MAX_LIMIT, SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { encodeV2SessionListCursorV1, decodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

describe('Board filtered item-source settlement', () => {
    it('settles 1,000 Sessions using the released exhaustive page budget, not visible-list round trips', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const records = Array.from({ length: 1000 }, (_, index) => {
            const session = createSessionFixture({ id: `budget-${index}`, active: true, activeAt: Date.now() });
            return { ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id, active: true, activeAt: session.activeAt }),
                viewer: createSessionOwnerViewerFixture(session) };
        });
        const indices = new Map(records.map((row, index) => [row.id, index]));
        const sizes: number[] = [];
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const query = SessionListQueryV1Schema.parse(input);
            const limit = query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT;
            const cursorId = query.cursor ? decodeV2SessionListCursorV1(query.cursor) : null;
            const from = cursorId ? indices.get(cursorId)! + 1 : 0;
            const sessions = records.slice(from, from + limit);
            sizes.push(sessions.length);
            const hasNext = from + sessions.length < records.length;
            return { body: createSessionListSourceFixture({ sessions,
                nextCursor: hasNext ? encodeV2SessionListCursorV1(sessions.at(-1)!.id) : null, hasNext,
                attentionNextCursor: null, attentionHasNext: false }) };
        } });
        const board = { ...createWorkBoardV1({ id: 'page-budget', name: 'Page budget' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId] }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT; environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const startedAt = performance.now();
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current?.members).toHaveLength(records.length);
            console.info('FX-125b released page budget', { sessions: records.length, pages: sizes.length,
                settleMs: performance.now() - startedAt, sizes });
            expect(sizes).toHaveLength(Math.ceil(records.length / SESSION_LIST_PAGE_MAX_LIMIT));
            expect(sizes.every(size => size <= SESSION_LIST_PAGE_MAX_LIMIT)).toBe(true);
        } finally {
            await act(async () => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it.each([false, true])('finishes a 1,000-Session Project census despite in-flight Home wakes (queued refresh fails: %s)', async fails => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const ids = Array.from({ length: 1000 }, (_, index) => `waking-${index}`);
        const gates = Array.from({ length: 4 }, () => createDeferred<void>());
        const cursors: (string | undefined)[] = [];
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const cursor = input !== null && typeof input === 'object' && 'cursor' in input && typeof input.cursor === 'string' ? input.cursor : undefined;
            const index = cursors.length;
            cursors.push(cursor);
            if (fails && index === 2) return { status: 503, body: { error: 'temporarily_unavailable' } };
            return { body: createSessionListSourceFixture({ sessions: ids.slice(cursor ? 500 : 0, cursor ? 1000 : 500).map(id => ({
                ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: 'anchor' }),
                viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
            })), nextCursor: cursor ? null : 'tail', hasNext: !cursor, attentionNextCursor: null, attentionHasNext: false }),
                ...(gates[index] ? { respondAfter: gates[index].promise } : {}) };
        } });
        applyProjectAccountRowsFixture(storage);
        const board = { ...createWorkBoardV1({ id: 'waking-project', name: 'Waking Project' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId],
                projects: { include: [{ serverId, projectKey: 'anchor' }], exclude: [] } }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        const emissions: number[] = [];
        function Host() {
            const membership = useBoardMembership(board, homes); value.current = membership;
            React.useLayoutEffect(() => { emissions.push(membership.members.length); }, [membership.members]);
            return null;
        }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT; environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const wake = async () => act(async () => {
            storage.getState().applyServerScopedSessionListRows(serverId,
                [createSessionListRenderableSessionFixture({ id: ids[0], projectKey: 'anchor' })], { source: 'rowOnly', mode: 'append' });
            publishHomeAccountChange(serverId, [ids[0]!], { changeKinds: ['session'], sessionListQueryAffects: true });
        });
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(cursors).toHaveLength(1));
            await wake();
            await act(async () => gates[0]!.resolve());
            await waitForSessionListQueryState(() => expect(cursors.length).toBeGreaterThanOrEqual(2));
            expect(cursors.slice(0, 2)).toEqual([undefined, 'tail']);
            expect(value.current?.settled).toBe(false);
            await wake();
            await act(async () => gates[1]!.resolve());
            await waitForSessionListQueryState(() => expect(cursors.length).toBeGreaterThanOrEqual(3));
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current?.members).toHaveLength(1000);
            expect(emissions).toEqual([0, 1000]);
            if (fails) expect(cursors).toHaveLength(3);
            else {
                const admitted = value.current!.members;
                await wake();
                await act(async () => gates[2]!.resolve());
                await waitForSessionListQueryState(() => expect(cursors.length).toBeGreaterThanOrEqual(4));
                expect(cursors.slice(0, 4)).toEqual([undefined, 'tail', undefined, 'tail']);
                expect(value.current?.settled).toBe(true);
                expect(value.current?.members).toBe(admitted);
                await act(async () => gates[3]!.resolve());
                await waitForSessionListQueryState(() => expect(value.current?.complete).toBe(true));
                expect(cursors).toEqual([undefined, 'tail', undefined, 'tail', undefined, 'tail']);
                expect(emissions).toEqual([0, 1000]);
            }
        } finally {
            for (const gate of gates) gate.resolve();
            await act(async () => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it('withdraws a settled source when the real query owner denies access, rather than retaining it as a refresh', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        boundary.http.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({ sessions: [{
            ...createPlainSessionCurrentProjectionRecordFixture({ id: 'formerly-accessible' }),
            viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: 'formerly-accessible' })),
        }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) });
        const board = { ...createWorkBoardV1({ id: 'denied-source', name: 'Denied source' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId] }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current?.members).toHaveLength(1);
            boundary.http.answer(serverId, '/v2/sessions/query', { status: 403, body: { error: 'access_denied', code: 'access_denied' } });
            await act(async () => { await invalidateSessionListQueryHome(serverId); });
            expect(value.current?.members).toEqual([]);
            expect(value.current?.settled).toBe(false);
        } finally {
            await act(async () => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it('does not reevaluate 1,000 settled filter candidates for one out-of-corpus row arrival', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const ids = Array.from({ length: 1000 }, (_, index) => `candidate-${index}`);
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const tail = input !== null && typeof input === 'object' && 'cursor' in input && input.cursor === 'tail';
            return { body: createSessionListSourceFixture({ sessions: ids.slice(tail ? 500 : 0, tail ? 1000 : 500).map(id => ({
                ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: 'anchor' }),
                viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
            })), nextCursor: tail ? null : 'tail', hasNext: !tail, attentionNextCursor: null, attentionHasNext: false }) };
        } });
        applyProjectAccountRowsFixture(storage);
        const board = { ...createWorkBoardV1({ id: 'filter-cost', name: 'Filter cost' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId],
                projects: { include: [{ serverId, projectKey: 'anchor' }], exclude: [] } }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const startedAt = performance.now();
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current?.members).toHaveLength(1000);
            const settledAt = performance.now();
            const admitted = value.current!.members;
            let unchangedFactReads = 0;
            for (const id of ids) {
                const row = storage.getState().sessionListRowsByServerId[serverId]![id]!;
                const projectKey = row.projectKey;
                // Count reads of the actual producer-owned input, keeping all matcher logic real.
                Object.defineProperty(row, 'projectKey', { configurable: true, enumerable: true,
                    get() { unchangedFactReads += 1; return projectKey; } });
            }
            await act(async () => storage.getState().applyServerScopedSessionListRows(serverId,
                [createSessionListRenderableSessionFixture({ id: 'outside-filter-corpus' })], { source: 'rowOnly', mode: 'append' }));
            const arrivalAt = performance.now();
            expect(value.current!.members).toBe(admitted);
            console.info('FX-125b item7 filter cost', { sessions: ids.length, settleMs: settledAt - startedAt,
                unrelatedArrivalMs: arrivalAt - settledAt, unchangedFactReads });
            expect(unchangedFactReads).toBe(0);
            await act(async () => storage.getState().applyServerScopedSessionListRows(serverId,
                [createSessionListRenderableSessionFixture({ id: ids[0], projectKey: 'another-project' })], { source: 'rowOnly', mode: 'append' }));
            expect(value.current!.members).toHaveLength(999);
            expect(value.current!.members.some(member => member.ref.qualifiedId.id === ids[0])).toBe(false);
            expect(unchangedFactReads).toBe(0);
            expect(value.current!.settled).toBe(true);
        } finally {
            await act(async () => root.unmount()); container.remove(); environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it('settles the Project corpus without demanding the visible-list attention supplement', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const attention = createDeferred<void>();
        const rows = ['known-project', 'unknown-project'].map(id => ({
            ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: id === 'known-project' ? 'anchor' : null,
                metadata: { path: '/repo', host: 'test', workspaceId: 'unresolved' } }),
            viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
        }));
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const request = input as Readonly<{ cursor?: string; attentionCursor?: string; includeAttention?: boolean }>;
            const tail = request.cursor === 'tail';
            const supplement = request.includeAttention === true;
            return { body: createSessionListSourceFixture({ sessions: request.attentionCursor ? [rows[0]!] : [rows[tail ? 1 : 0]!],
                nextCursor: tail || request.attentionCursor ? null : 'tail', hasNext: !tail && !request.attentionCursor,
                attentionNextCursor: supplement && !request.attentionCursor ? 'attention-tail' : null,
                attentionHasNext: supplement && !request.attentionCursor }),
                ...(request.attentionCursor ? { respondAfter: attention.promise } : {}) };
        } });
        applyProjectAccountRowsFixture(storage);
        const board = { ...createWorkBoardV1({ id: 'project-corpus', name: 'Project corpus' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
                homeServerIds: [serverId], projects: { include: [{ serverId, projectKey: 'anchor' }], exclude: [] } }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(storage.getState().sessionListRowsByServerId[serverId]?.['unknown-project']).toBeDefined());
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current?.members.map(member => member.ref.qualifiedId.id)).toEqual(['known-project']);
            expect(value.current?.undetermined).toMatchObject({ count: 1, reasons: [{ reason: 'project_association_unavailable', count: 1 }] });
            expect(boundary.http.requestsFor('/v2/sessions/query').filter(request => request.serverId === serverId)).toHaveLength(2);
            const admitted = value.current!.members;
            const qualification = value.current!.undetermined;
            await act(async () => applyProjectAccountRowsFixture(storage, { status: 'loading' }));
            expect(value.current?.settled).toBe(true);
            expect(value.current?.members).toBe(admitted);
            expect(value.current?.undetermined).toBe(qualification);
        } finally {
            attention.resolve();
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it('publishes one settled membership for 1,000 Sessions, keeps it through page refreshes, and emits only real changes', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        let ids = Array.from({ length: 1000 }, (_, index) => `member-${index}`);
        let pageGates = [createDeferred<void>(), createDeferred<void>()];
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const second = input !== null && typeof input === 'object' && 'cursor' in input && input.cursor === 'tail';
            const selected = second ? ids.slice(500) : ids.slice(0, 500);
            return { body: createSessionListSourceFixture({ sessions: selected.map(id => ({
                ...createPlainSessionCurrentProjectionRecordFixture({ id }),
                viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
            })), nextCursor: second ? null : 'tail', hasNext: !second,
                attentionNextCursor: null, attentionHasNext: false }), respondAfter: pageGates[second ? 1 : 0]!.promise };
        } });
        const picked = { kind: 'session' as const, qualifiedId: { serverId, id: 'picked' } };
        let board = { ...createWorkBoardV1({ id: 'settled-board', name: 'Settled membership' }), source: {
            picked: [picked], filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId] }),
        } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        const emissions: number[] = [];
        function Host() {
            const membership = useBoardMembership(board, homes);
            value.current = membership;
            React.useLayoutEffect(() => { emissions.push(membership.members.length); }, [membership.members]);
            return null;
        }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const requests = () => boundary.http.requestsFor('/v2/sessions/query').filter(request => request.serverId === serverId).length;
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(requests()).toBe(1));
            const cold = value.current!.members;
            expect(cold.map(member => member.ref.qualifiedId.id)).toEqual(['picked']);
            await act(async () => { pageGates[0]!.resolve(); });
            await waitForSessionListQueryState(() => expect(requests()).toBe(2));
            expect(value.current!.members).toBe(cold);
            await act(async () => { pageGates[1]!.resolve(); });
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current!.members).toHaveLength(1001);
            expect(emissions).toEqual([1, 1001]);
            const settled = value.current!.members;
            for (const changed of [false, true]) {
                if (changed) ids = [...ids.slice(1), 'new-member'];
                emissions.length = 0;
                pageGates = [createDeferred<void>(), createDeferred<void>()];
                const before = requests();
                let refresh: Promise<void> = Promise.resolve();
                await act(async () => {
                    if (changed) refresh = invalidateSessionListQueryHome(serverId);
                    else publishHomeAccountChange(serverId, ['member-0'], { changeKinds: ['session'], sessionListQueryAffects: true });
                });
                await waitForSessionListQueryState(() => expect(requests()).toBe(before + 1));
                expect(value.current!.members).toBe(settled);
                expect(value.current!.settled).toBe(true);
                board = { ...board, source: { ...board.source, filter: normalizeSessionListFilterV1(board.source.filter) } };
                await act(async () => root.render(<Host />));
                expect(value.current!.members).toBe(settled);
                await act(async () => { pageGates[0]!.resolve(); });
                await waitForSessionListQueryState(() => expect(requests()).toBe(before + 2));
                expect(value.current!.members).toBe(settled);
                expect(value.current!.settled).toBe(true);
                expect(emissions).toEqual([]);
                await act(async () => { pageGates[1]!.resolve(); await refresh; });
                await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
                expect(requests()).toBe(before + 2);
                expect(emissions).toEqual(changed ? [1001] : []);
                expect(value.current!.members.some(member => member.ref.qualifiedId.id === 'new-member')).toBe(changed);
                expect(value.current!.members.find(member => member.ref.qualifiedId.id === 'member-1'))
                    .toBe(settled.find(member => member.ref.qualifiedId.id === 'member-1'));
                if (!changed) expect(value.current!.members).toBe(settled);
            }
        } finally {
            for (const gate of pageGates) gate.resolve();
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it.each([
        { field: 'projects', censusStatus: 'ready' }, { field: 'branches', censusStatus: 'ready' },
        { field: 'extensions', censusStatus: 'ready' }, { field: 'projects', censusStatus: 'refused' },
    ] as const)('settles answered unknown $field candidates with a $censusStatus census without claiming complete membership', async ({ field, censusStatus }) => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const answer = createDeferred<void>();
        const selected = field === 'projects' ? { projects: { include: [{ serverId, projectKey: 'anchor' }], exclude: [] } }
            : field === 'branches' ? { branches: { include: ['main'], exclude: [] } }
            : { extensions: { 'retired/field': { kind: 'boolean' as const, value: true } } };
        const rows = ['known', 'unknown'].map(id => ({
            ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: id === 'known' ? 'anchor' : null,
                metadata: { path: '/repo', host: 'test', workspaceId: 'unresolved', ...(id === 'known' ? { branch: 'main' } : {}) } }),
            viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
        }));
        boundary.http.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({ sessions: rows,
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }), respondAfter: answer.promise });
        applyProjectAccountRowsFixture(storage, { status: censusStatus });
        const board = { ...createWorkBoardV1({ id: 'unknown-board', name: 'Unknown filter' }), source: { picked: [],
            filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId], ...selected }) } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Host />));
            await waitForSessionListQueryState(() => expect(boundary.http.requestsFor('/v2/sessions/query').length).toBeGreaterThan(0));
            expect(value.current?.settled).toBe(false);
            await act(async () => { answer.resolve(); await answer.promise; });
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current).toMatchObject({ complete: false, undetermined: { count: field === 'extensions' ? 2 : 1,
                reasons: [{ kind: 'session', reason: field === 'projects' ? 'project_association_unavailable' : 'filter_facts_unavailable', count: field === 'extensions' ? 2 : 1 }] } });
            expect(value.current?.members.map(member => member.ref.qualifiedId.id)).toEqual(field === 'extensions' ? [] : ['known']);
            expect(boundary.http.requestsFor('/v2/sessions/query').filter(request => request.serverId === serverId)).toHaveLength(1);
        } finally {
            answer.resolve();
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
    it.each([false, true])('waits for query pages and the Project census (with items: %s)', async withItems => {
        const boundary = await createSessionListQuerySourceHarness();
        const serverId = boundary.focusedHome();
        const first = createDeferred<void>();
        const last = createDeferred<void>();
        const session = createSessionFixture({ id: 'project-session', projectKey: 'anchor' });
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const cursor = input && typeof input === 'object' && 'cursor' in input ? input.cursor : null;
            return { body: createSessionListSourceFixture({
                sessions: cursor && withItems ? [{
                    ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id, projectKey: 'anchor' }),
                    viewer: createSessionOwnerViewerFixture(session),
                }] : [],
                nextCursor: cursor ? null : 'last-page', hasNext: !cursor,
                attentionNextCursor: null, attentionHasNext: false,
            }), respondAfter: cursor ? last.promise : first.promise };
        } });
        storage.setState({ projectAccountRows: null });
        const board = { ...createWorkBoardV1({ id: 'project-board', name: 'Project filter' }), source: {
            picked: [], filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible',
                homeServerIds: [serverId], projects: { include: [{ serverId, projectKey: 'anchor' }], exclude: [] } }),
        } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const value: { current: ReturnType<typeof useBoardMembership> | null } = { current: null };
        function Host() { value.current = useBoardMembership(board, homes); return null; }
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => { root.render(<Host />); });
            await waitForSessionListQueryState(() => expect(boundary.http.requestsFor('/v2/sessions/query').length).toBeGreaterThan(0));
            expect(value.current).toMatchObject({ members: [], settled: false });
            await act(async () => { first.resolve(); await first.promise; });
            await waitForSessionListQueryState(() => expect(boundary.http.requestsFor('/v2/sessions/query').some(request =>
                request.input !== null && typeof request.input === 'object' && 'cursor' in request.input
                && request.input.cursor === 'last-page')).toBe(true));
            expect(value.current).toMatchObject({ members: [], settled: false });
            await act(async () => { last.resolve(); await last.promise; });
            // The query has answered, but the selected Project's own reader has not.
            expect(value.current?.complete).toBe(false);
            expect(value.current?.settled).toBe(false);
            await act(async () => applyProjectAccountRowsFixture(storage));
            await waitForSessionListQueryState(() => expect(value.current?.settled).toBe(true));
            expect(value.current).toMatchObject({ complete: true, undetermined: { count: 0, reasons: [] } });
            expect(value.current?.members.map(member => member.ref.qualifiedId.id)).toEqual(withItems ? [session.id] : []);
            const pages = boundary.http.requestsFor('/v2/sessions/query').filter(request => request.serverId === serverId);
            expect(pages).toHaveLength(2);
        } finally {
            first.resolve(); last.resolve();
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            await boundary.dispose();
        }
    });
});
