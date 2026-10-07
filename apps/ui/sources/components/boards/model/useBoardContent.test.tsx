import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkBoardIntentV1, buildWorkBoardItemKeyV1, createWorkBoardV1, encodePlainArtifactStoredContent, normalizeSessionListFilterV1 } from '@happier-dev/protocol';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ARTIFACT_LIST_PATH, AUTOMATION_LIST_PATH, RUN_STORAGE_PATH, boardDefinitionArtifact, boardRunStoragePage, installBoardLibraryTestHarness } from '../boardLibraryTestHarness';
import type { BoardHomes } from './useBoardContent';
import { formatWorkflowDefinitionContentUnavailableReason } from '@/components/workflows/presentation/workflowProblemPresentation';

const harness = installBoardLibraryTestHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useBoardCards, useBoardMembership, useBoardWidgets } = await import('./useBoardContent');
const { resolveBoardPruneMembership } = await import('./boardMembership');
const { buildBoardCards } = await import('./boardCards');
const { useWorkflowDefinitionLibrary, useWorkflowRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
const runAnswer = vi.fn<(input: unknown) => HomeDomainAnswer>();
// Markdown is a third-party rendering boundary; membership never renders it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

let previousState = storage.getState();
let homes: BoardHomes;
beforeEach(async () => {
    previousState = storage.getState();
    const serverId = await harness.connect('http://board-runs.test');
    storage.setState({ profileScope: { serverId, accountId: 'account-a' },
        workflowRunsById: {}, workflowRunListWindows: {} });
    homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId };
    harness.home.answer(serverId, RUN_STORAGE_PATH, { select: runAnswer });
});
afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    await harness.dispose();
    runAnswer.mockReset();
    storage.setState(previousState);
});

function runsBoard(startedBy: readonly ('you' | 'agents' | 'triggers')[] = []) {
    return { ...createWorkBoardV1({ id: 'board-runs', name: 'Runs' }), source: { picked: [],
        filter: normalizeSessionListFilterV1({ show: 'runs', startedBy, homeServerIds: homes.mountedServerIds }),
    } };
}

describe('Board shared Run filter membership', () => {
    it('preserves unavailable definition reasons on Board cards beside readable neighbors', async () => {
        const definitionIds = ['header', 'body', 'readable'];
        // Only stored HTTP bytes are malformed; the real Artifact codec and
        // Workflow list owner classify each row beside its readable neighbor.
        harness.home.answer(homes.activeServerId!, ARTIFACT_LIST_PATH, { body: [
            { ...boardDefinitionArtifact('header', 'Unavailable'), header: encodePlainArtifactStoredContent({
                kind: 'workflow-definition.v1', definitionId: 'header',
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 7 },
            }) },
            { ...boardDefinitionArtifact('body', 'Repair me'), body: encodePlainArtifactStoredContent({ body: 'not-json' }) },
            boardDefinitionArtifact('readable', 'Readable'),
        ] });
        runAnswer.mockReturnValue({ body: { summaries: [], remainingSourceArtifactIds: [] } });
        const members = definitionIds.map(definitionId => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definitionId } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => ({
            cards: useBoardCards({ members, complete: true }, homes),
            library: useWorkflowDefinitionLibrary(),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().library.status).toBe('loaded'));
        expect(hook.getCurrent().cards).toMatchObject([
            { availability: 'content_unavailable', unavailableReason: formatWorkflowDefinitionContentUnavailableReason('invalid_header'), body: { kind: 'none' } },
            { availability: 'content_unavailable', title: 'Repair me', unavailableReason: formatWorkflowDefinitionContentUnavailableReason('invalid_body'), body: { kind: 'none' } },
            { availability: 'ready', title: 'Readable', body: { kind: 'workflow' } },
        ]);
        expect(hook.getCurrent().cards.slice(0, 2).every(card => card.status.tone === 'neutral')).toBe(true);
    });
    it('consumes the definition list scheduler occurrence without deriving a date from its schedule', async () => {
        const definitions = [
            { definitionId: '11111111-1111-4111-8111-111111111111', nextRunAt: 123_456 },
            { definitionId: '22222222-2222-4222-8222-222222222222', nextRunAt: null },
        ];
        harness.home.answer(homes.activeServerId!, ARTIFACT_LIST_PATH, { body: definitions.map((definition, index) =>
            boardDefinitionArtifact(definition.definitionId, `Schedule ${index}`)) });
        harness.home.answer(homes.activeServerId!, AUTOMATION_LIST_PATH, { body: {
            automations: definitions.map(({ definitionId, nextRunAt }, index) => ({
                id: `automation-${index}`, name: 'Scheduled workflow', description: null, enabled: true,
                workflowDefinitionId: definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
                templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
                triggers: [{ id: `trigger-${index}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                    kind: 'schedule', schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt }],
            })), nextCursor: null,
        } });
        runAnswer.mockReturnValue({ body: { summaries: [], remainingSourceArtifactIds: [] } });
        const members = definitions.map(definition => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definition.definitionId } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => ({
            cards: useBoardCards({ members, complete: true }, homes),
            library: useWorkflowDefinitionLibrary(),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().library.status).toBe('loaded'));
        expect(hook.getCurrent().library.definitions.map(definition => definition.nextRunAt)).toEqual([123_456, null]);
        expect(hook.getCurrent().cards.map(card => card.body)).toMatchObject([
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
        const pending = createDeferred<void>();
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([first], 'page-two') });
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([second]), respondAfter: pending.promise });
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members).toHaveLength(1));
        const partial = hook.getCurrent();
        // A drag on page one cannot discard the already saved page-two layout.
        const moved = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [buildWorkBoardItemKeyV1(partial.members[0]!.ref)]: { x: 90, y: 80 } },
            membership: resolveBoardPruneMembership(board, partial, homes.isHomeMounted) });
        expect(moved.status).toBe('applied');
        if (moved.status !== 'applied') throw new Error('position edit refused');
        expect(moved.boards.boards[0]!.positionsByItemRef[secondKey]).toEqual({ x: 12, y: 34 });
        expect(partial.complete).toBe(false);
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).some(request =>
            request.input !== null && typeof request.input === 'object' && 'request' in request.input
            && (request.input.request as { cursor?: string }).cursor === 'page-two')).toBe(true));
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['first', 'second']));
        expect(hook.getCurrent().complete).toBe(true);
    });

    it('never prunes Running positions after a failed first read or failed refresh', async () => {
        const row = createWorkflowRunSummaryFixture({ id: 'saved', state: 'running' });
        const savedKey = buildWorkBoardItemKeyV1({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: row.id } });
        const board = { ...createWorkBoardV1({ id: 'running', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const }, positionsByItemRef: { [savedKey]: { x: 12, y: 34 } } };
        runAnswer.mockReturnValueOnce({ dispatchThenFail: true });
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('active') }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('failed'));
        const savedAfterEdit = () => {
            const result = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
                positionsByItemRef: {}, membership: resolveBoardPruneMembership(board, hook.getCurrent().membership, homes.isHomeMounted) });
            if (result.status !== 'applied') throw new Error('position edit refused');
            return result.boards.boards[0]!;
        };
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
        expect(hook.getCurrent().membership.complete).toBe(false);
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([row]) });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().membership.complete).toBe(true));
        runAnswer.mockReturnValueOnce({ dispatchThenFail: true });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('failed'));
        expect(hook.getCurrent().membership.complete).toBe(false);
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
    });

    it('treats an answered empty Run window as complete', async () => {
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([]) });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members).toEqual([]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().complete).toBe(true));
    });

    it('uses the shared starter and attention rule, deduplicates picks, and retains membership identity on unrelated writes', async () => {
        const waiting = createWorkflowRunSummaryFixture({ id: 'waiting', startedBy: 'trigger', attentionRequired: true });
        const user = createWorkflowRunSummaryFixture({ id: 'user', startedBy: 'user' });
        const agent = createWorkflowRunSummaryFixture({ id: 'agent', startedBy: 'agent' });
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([waiting, user, agent]) });
        const initial = runsBoard(['you']);
        const board = { ...initial, source: { ...initial.source, picked: [
            { kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: 'waiting' } } as const,
        ] } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['waiting', 'user']));
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
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([first], 'page-two') });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['first']));
        expect(hook.getCurrent().complete).toBe(false);
        expect(harness.home.requestsFor(RUN_STORAGE_PATH).filter(request =>
            request.input !== null && typeof request.input === 'object' && 'operation' in request.input && request.input.operation === 'list')).toHaveLength(1);
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
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([createWorkflowRunSummaryFixture({ id: 'active-run', startedBy: 'user' })]) });
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['active-run', 'inactive-run']));
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
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([old]) });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['old']));
        const pending = createDeferred<void>();
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([]), respondAfter: pending.promise });
        await act(async () => { await harness.switchAccount(homes.activeServerId!, 'http://board-runs.test', 'account-b'); });
        expect(hook.getCurrent().members).toEqual([]);
        expect(hook.getCurrent().complete).toBe(false);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().complete).toBe(true));
    });
});
