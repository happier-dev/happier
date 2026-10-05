import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkBoardIntentV1, buildWorkBoardItemKeyV1, createWorkBoardV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { useBoardCards, useBoardMembership, useBoardWidgets, type BoardHomes } from './useBoardContent';
import { resolveBoardPruneMembership } from './boardMembership';
import { buildBoardCards } from './boardCards';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';

const execute = vi.hoisted(() => vi.fn());
// The Action executor is the transport boundary. The list client, window, shared Run store,
// normalization, predicate and Board projection all execute their real implementations.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
// Markdown is a third-party rendering boundary; membership never renders it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let previousState = storage.getState();
let homes: BoardHomes;
beforeEach(async () => {
    previousState = storage.getState();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const profile = await runtime.upsertAndActivateServer({ serverUrl: 'http://board-runs.test', name: 'Board Home' });
    storage.setState({ profileScope: { serverId: profile.id, accountId: 'account-a' },
        workflowRunsById: {}, workflowRunListWindows: {} });
    homes = { activeServerId: profile.id, mountedServerIds: [profile.id], isHomeMounted: (id) => id === profile.id };
});
afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    storage.setState(previousState);
});

function runsBoard(startedBy: readonly ('you' | 'agents' | 'triggers')[] = []) {
    return { ...createWorkBoardV1({ id: 'board-runs', name: 'Runs' }), source: { picked: [],
        filter: normalizeSessionListFilterV1({ show: 'runs', startedBy, homeServerIds: homes.mountedServerIds }),
    } };
}

describe('Board shared Run filter membership', () => {
    it('consumes the definition list scheduler occurrence without deriving a date from its schedule', async () => {
        const definitions = [123_456, null].map((nextRunAt, index) => ({
            kind: 'workflow-definition.v1', definitionId: `scheduled-${index}`,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Schedule ${index}` },
            contentStatus: 'available', stepCount: 1, nextRunAt,
            triggers: [{ kind: 'schedule', schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
        }));
        execute.mockImplementation(async (id) => id === 'workflow.definition.list'
            ? { ok: true, result: { definitions } }
            : id === 'workflow.run.summaries'
                ? { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } }
                : { ok: false, errorCode: 'unexpected_action' });
        const members = definitions.map(definition => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definition.definitionId } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => useBoardCards({ members, complete: true }, homes));
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(hook.getCurrent().map(card => card.body)).toMatchObject([
            { kind: 'workflow', nextRun: { kind: 'scheduled', at: 123_456 } },
            { kind: 'workflow', nextRun: { kind: 'unscheduled' } },
        ]);
    });
    it('projects both widget copies in Board order independently of work/status membership and mode', async () => {
        const surface = { serverId: homes.activeServerId!, accountId: 'account-a', owner: { kind: 'workBoard', boardId: 'widgets' } } as const;
        const instance = { v: 1, id: 'first', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        let board = createWorkBoardV1({ id: 'widgets', name: 'Mixed' });
        const add = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'widget_add', boardId: board.id, ref: { surface, instanceId: instance.id }, instance, width: 2 });
        if (add.status !== 'applied') throw new Error('add failed'); board = add.boards.boards[0]!;
        const next = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'widget_add', boardId: board.id, ref: { surface, instanceId: 'second' }, instance: { ...instance, id: 'second', bindings: { session: { kind: 'value', value: 'other' } } }, toIndex: 0 });
        if (next.status !== 'applied') throw new Error('add failed'); board = next.boards.boards[0]!;
        const hook = await renderHook(useBoardWidgets, { initialProps: board });
        expect(hook.getCurrent().map(item => [item.instance.id, item.width])).toEqual([['second', 1], ['first', 2]]);
        expect((await hook.rerender({ ...board, mode: 'by_status' })).map(item => item.instance.id)).toEqual(['second', 'first']);
    });
    it('keeps Running positions through paging and consumes the existing window continuation before certifying completeness', async () => {
        const first = createWorkflowRunSummaryFixture({ id: 'first', state: 'running' });
        const second = createWorkflowRunSummaryFixture({ id: 'second', state: 'running' });
        const secondKey = buildWorkBoardItemKeyV1({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: second.id } });
        const board = { ...createWorkBoardV1({ id: 'running', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const }, positionsByItemRef: { [secondKey]: { x: 12, y: 34 } } };
        const pending = createDeferred<unknown>();
        execute.mockResolvedValueOnce({ ok: true, result: { runs: [first], metadataByRunId: {}, nextCursor: 'page-two' } });
        execute.mockReturnValueOnce(pending.promise);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        const partial = hook.getCurrent();
        // A drag on page one cannot discard the already saved page-two layout.
        const moved = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [buildWorkBoardItemKeyV1(partial.members[0]!.ref)]: { x: 90, y: 80 } },
            membership: resolveBoardPruneMembership(board, partial, homes.isHomeMounted) });
        expect(moved.status).toBe('applied');
        if (moved.status !== 'applied') throw new Error('position edit refused');
        expect(moved.boards.boards[0]!.positionsByItemRef[secondKey]).toEqual({ x: 12, y: 34 });
        expect(partial.complete).toBe(false);
        expect(execute.mock.calls.find(([id, input]) => id === 'workflow.run.list' && input.cursor === 'page-two')).toBeDefined();
        await act(async () => { pending.resolve({ ok: true, result: { runs: [second], metadataByRunId: {} } }); await pending.promise; });
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['first', 'second']);
        expect(hook.getCurrent().complete).toBe(true);
    });

    it('never prunes Running positions after a failed first read or failed refresh', async () => {
        const row = createWorkflowRunSummaryFixture({ id: 'saved', state: 'running' });
        const savedKey = buildWorkBoardItemKeyV1({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: row.id } });
        const board = { ...createWorkBoardV1({ id: 'running', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const }, positionsByItemRef: { [savedKey]: { x: 12, y: 34 } } };
        execute.mockRejectedValueOnce(new Error('offline'));
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('active') }));
        const savedAfterEdit = () => {
            const result = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
                positionsByItemRef: {}, membership: resolveBoardPruneMembership(board, hook.getCurrent().membership, homes.isHomeMounted) });
            if (result.status !== 'applied') throw new Error('position edit refused');
            return result.boards.boards[0]!;
        };
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
        expect(hook.getCurrent().membership.complete).toBe(false);
        execute.mockResolvedValueOnce({ ok: true, result: { runs: [row], metadataByRunId: {} } });
        await act(async () => { hook.getCurrent().window.retry(); });
        expect(hook.getCurrent().membership.complete).toBe(true);
        execute.mockRejectedValueOnce(new Error('offline refresh'));
        await act(async () => { hook.getCurrent().window.retry(); });
        expect(hook.getCurrent().window.status).toBe('failed');
        expect(hook.getCurrent().membership.complete).toBe(false);
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
    });

    it('treats an answered empty Run window as complete', async () => {
        execute.mockResolvedValue({ ok: true, result: { runs: [], metadataByRunId: {} } });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members).toEqual([]);
        expect(hook.getCurrent().complete).toBe(true);
    });

    it('uses the shared starter and attention rule, deduplicates picks, and retains membership identity on unrelated writes', async () => {
        const waiting = createWorkflowRunSummaryFixture({ id: 'waiting', startedBy: 'trigger', attentionRequired: true });
        const user = createWorkflowRunSummaryFixture({ id: 'user', startedBy: 'user' });
        const agent = createWorkflowRunSummaryFixture({ id: 'agent', startedBy: 'agent' });
        execute.mockResolvedValue({ ok: true, result: { runs: [waiting, user, agent], metadataByRunId: {} } });
        const initial = runsBoard(['you']);
        const board = { ...initial, source: { ...initial.source, picked: [
            { kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: 'waiting' } } as const,
        ] } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['waiting', 'user']);
        expect(hook.getCurrent().members[0]?.picked).toBe(true);
        expect(hook.getCurrent().complete).toBe(true);
        const membership = hook.getCurrent();
        act(() => { storage.setState({ workflowRunsById: { ...storage.getState().workflowRunsById,
            unrelated: { ...storage.getState().workflowRunsById.user!, id: 'unrelated' },
        } }); });
        expect(hook.getCurrent()).toBe(membership);
    });

    it('preserves partial Run membership and refuses to certify a paged window as complete', async () => {
        const first = createWorkflowRunSummaryFixture({ id: 'first', startedBy: 'user' });
        execute.mockResolvedValue({ ok: true, result: { runs: [first], metadataByRunId: {}, nextCursor: 'page-two' } });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['first']);
        expect(hook.getCurrent().complete).toBe(false);
        expect(execute.mock.calls.filter(([id]) => id === 'workflow.run.list')).toHaveLength(1);
    });

    it('preserves placed Runs from a mounted Home not served by the active Home window', async () => {
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const other = await upsertServerProfileOnly({ serverUrl: 'http://board-runs-second.test', name: 'Second Board Home' });
        const mountedServerIds = [homes.activeServerId!, other.id];
        homes = { ...homes, mountedServerIds, isHomeMounted: (id) => mountedServerIds.includes(id) };
        const inactiveKey = buildWorkBoardItemKeyV1({
            kind: 'workflow_run', qualifiedId: { serverId: other.id, id: 'inactive-run' },
        });
        const board = { ...runsBoard(['you']), positionsByItemRef: { [inactiveKey]: { x: 12, y: 34 } } };
        execute.mockResolvedValue({ ok: true, result: {
            runs: [createWorkflowRunSummaryFixture({ id: 'active-run', startedBy: 'user' })], metadataByRunId: {},
        } });
        const hook = await renderHook(() => useBoardMembership(board, homes));
        const membership = hook.getCurrent();
        expect(membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['active-run', 'inactive-run']);
        expect(membership.members.find((member) => member.key === inactiveKey)?.available).toBe(false);
        const cards = buildBoardCards(membership.members, {
            nowMs: Date.now(), session: () => null, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: (id) => id === homes.activeServerId,
        });
        expect(cards.find((card) => card.key === inactiveKey)?.availability).toBe('home_unavailable');
        expect(resolveBoardPruneMembership(board, membership, homes.isHomeMounted).liveItemKeys).toContain(inactiveKey);
        expect(membership.complete).toBe(false);
    });

    it('retires Account-A membership while Account B loads through the same window owner', async () => {
        const old = createWorkflowRunSummaryFixture({ id: 'old', startedBy: 'user' });
        execute.mockResolvedValueOnce({ ok: true, result: { runs: [old], metadataByRunId: {} } });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['old']);
        const pending = createDeferred<unknown>();
        execute.mockReturnValueOnce(pending.promise);
        act(() => { storage.setState({ profileScope: { serverId: homes.activeServerId!, accountId: 'account-b' },
            workflowRunListWindows: {}, workflowRunsById: {} }); });
        expect(hook.getCurrent().members).toEqual([]);
        expect(hook.getCurrent().complete).toBe(false);
        await act(async () => { pending.resolve({ ok: true, result: { runs: [], metadataByRunId: {} } }); await pending.promise; });
        expect(hook.getCurrent().complete).toBe(true);
    });
});
