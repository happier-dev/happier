import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { buildWorkBoardItemKeyV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params && 'count' in params ? `${key}:${String(params.count)}` : key),
    });
});

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture, createWorkflowRunRecentSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import {
    buildBoardCards,
    countBoardCardsNeedingYou,
    createBoardCardProjection,
    createBoardSummaryProjection,
    countSessionsByMachine,
    createBoardMachineSessionProjection,
    describeBoardColumnLine,
    describeBoardSummaryLine,
    describeBoardUndetermined,
    reconcileBoardCards,
    type BoardCardFacts,
} from './boardCards';
import type { BoardMember } from './boardMembership';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { adoptHomeProfile, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createBoardSessionSourceProjection, readBoardMachineSourceState, readBoardPagedEntitySourceState, readBoardSessionSourceState, shouldLoadNextBoardEntityPage } from './boardEntityBinding';

const NOW = 1_000_000;
afterEach(clearMachineRequestReachabilityForTest);

function member(ref: BoardItemRefV1, available = true): BoardMember {
    return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available };
}

const permissionSession = createSessionListRenderableSessionFixture({
    id: 's-need',
    active: true,
    activeAt: NOW,
    hasPendingPermissionRequests: true,
    pendingRequestObservedAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});
const workingSession = createSessionListRenderableSessionFixture({
    id: 's-work',
    active: true,
    activeAt: NOW,
    thinking: true,
    thinkingAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});

describe('board cards', () => {
    it('withholds a Workflow from status columns until its summary answers, then publishes its actual status', () => {
        const ref = { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf-pending' } } as const;
        const members = [member(ref)];
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflowRun: () => null, accountScopedHome: () => true,
            workflow: () => ({ title: 'Release check', summary: null }),
        };
        const project = createBoardCardProjection();
        const summary = createBoardSummaryProjection();
        expect(buildBoardCards(members, facts)).toEqual([]);
        expect(project(members, facts)).toEqual([]);
        expect(summary(members, facts, 0)).toMatchObject({ itemCount: 1, needYou: null });
        const answered: BoardCardFacts = { ...facts,
            workflow: () => ({ title: 'Release check', summary: { needsYouCount: 1, lastRun: null } }),
        };
        expect(project(members, answered)).toMatchObject([{ title: 'Release check', status: { bucket: 'needs_you' } }]);
        expect(summary(members, answered, 0)).toMatchObject({ itemCount: 1, needYou: 1 });
        expect(project(members, { ...facts,
            workflow: () => ({ title: 'Release check', summary: { needsYouCount: 0, lastRun: null } }),
        })).toMatchObject([{ status: { bucket: 'idle' } }]);
    });

    it('classifies authorized teammate-only work through the shared Machine status owner', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const machine = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const scope = { serverId: 'home-a', accountId: 'owner' };
        observeMachinePresenceForTest(scope, [machine.id]);
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => machine, machineScope: () => scope, machineSessionCounts: new Map(), accountScopedHome: () => true,
            machineWorkSummary: () => ({ kind: 'summary', summary: { kind: 'current', requesters: [
                { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
            ] } }),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.status).toMatchObject({ bucket: 'working', tone: 'neutral' });
        expect(buildBoardCards([member(ref)], { ...facts, machineWorkSummary: () => ({ kind: 'denied' }) })[0]?.status.bucket).toBe('idle');
        expect(buildBoardCards([member(ref)], { ...facts, machineWorkSummary: () => ({ kind: 'summary', summary: { kind: 'unavailable' } }) })[0]?.status)
            .toMatchObject({ state: 'unknown', word: 'common.unknown' });
        // A summary push must bypass neither the stable Machine context nor per-card reuse.
        const project = createBoardCardProjection();
        const members = [member(ref)];
        const inputContexts = { machine: {} };
        const working = project(members, { ...facts, inputContexts });
        const idle = project(members, { ...facts, inputContexts,
            machineWorkSummary: () => ({ kind: 'summary', summary: { kind: 'current', requesters: [] } }) });
        expect(idle[0]?.status.bucket).toBe('idle');
        expect(idle[0]).not.toBe(working[0]);
    });
    it('reads only changed Session sources from a consecutive 1,000-Session publication', () => {
        const refs = Array.from({ length: 1000 }, (_, index) => ({ kind: 'session' as const,
            qualifiedId: { serverId: 'home-a', id: `member-${index}` } }));
        let rowReads = 0;
        const rows = Object.fromEntries(refs.map(ref => [ref.qualifiedId.id,
            createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id })]));
        const observe = (values: typeof rows) => new Proxy(values, { get(target, key, receiver) {
            if (typeof key === 'string' && key.startsWith('member-')) rowReads += 1;
            return Reflect.get(target, key, receiver);
        } });
        const state = { sessionListRowsByServerId: { 'home-a': observe(rows) }, deletedSessionIds: {},
            concurrentSessionListCacheByServerId: {}, sessionListRenderableDelta: { revision: 1,
                changedSessionIds: Object.keys(rows), removedSessionIds: [], rebuiltSessionListIndex: false } };
        const project = createBoardSessionSourceProjection();
        const initial = project(state, refs);
        rowReads = 0;
        const unchanged = project({ ...state }, refs);
        expect(rowReads).toBe(0);
        expect(unchanged).toBe(initial);
        const changed = { ...rows['member-7']!, hasPendingPermissionRequests: true };
        const nextState = { ...state, sessionListRowsByServerId: { 'home-a': observe({ ...rows, [changed.id]: changed }) },
            sessionListRenderableDelta: { revision: 2, changedSessionIds: [changed.id], removedSessionIds: [], rebuiltSessionListIndex: false } };
        rowReads = 0;
        const next = project(nextState, refs);
        expect(next.filter((source, index) => source !== initial[index])).toEqual([next[7]]);
        expect(next[7]?.row).toBe(changed);
        expect(rowReads).toBeLessThanOrEqual(2);
        // Non-delta writers and skipped publications require a complete read, never stale cards.
        const replaced = { ...rows['member-9']!, hasPendingUserActionRequests: true };
        const replacement = project({ ...nextState, sessionListRowsByServerId: { 'home-a': { ...rows, [replaced.id]: replaced } } }, refs);
        expect(replacement[9]?.row).toBe(replaced);
        const skipped = { ...rows['member-11']!, hasPendingUserActionRequests: true };
        const skippedState = { ...nextState, sessionListRowsByServerId: { 'home-a': { ...rows, [skipped.id]: skipped } },
            sessionListRenderableDelta: { ...nextState.sessionListRenderableDelta, revision: 4, changedSessionIds: ['outside-board'] } };
        expect(project(skippedState, refs)[11]?.row).toBe(skipped);
        // A lifecycle answer can settle a missing source without a row/delta publication.
        const missing = { ...skippedState, sessionListRowsByServerId: { 'home-a': {} } };
        project(missing, refs);
        expect(project({ ...missing, machineListStatusByServerId: { 'home-a': 'signedOut' } }, refs)[0]?.state).toBe('failed');
    });

    it('does no body comparison for unchanged identities on a 1,000-card arrival', () => {
        const members = Array.from({ length: 1000 }, (_, index) => member({ kind: 'session',
            qualifiedId: { serverId: 'home-a', id: `member-${index}` } }));
        const facts: BoardCardFacts = { nowMs: NOW, session: () => workingSession, workflowRun: () => null,
            workflow: () => null, machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const cards = buildBoardCards(members, facts);
        let bodyReads = 0;
        for (const card of cards) {
            const kind = card.body.kind;
            Object.defineProperty(card.body, 'kind', { enumerable: true, get: () => { bodyReads += 1; return kind; } });
        }
        const changed = { ...cards[7]!, title: 'Changed Session' };
        const next = cards.map((card, index) => index === 7 ? changed : card);
        const reconciled = reconcileBoardCards(cards, next);
        expect(reconciled.filter((card, index) => card !== cards[index])).toEqual([changed]);
        expect(bodyReads).toBe(0);
    });

    it('reads only changed Session inputs for one-row arrivals on a 1,000-card Board', () => {
        const members: BoardMember[] = Array.from({ length: 1000 }, (_, index) => member({ kind: 'session',
            qualifiedId: { serverId: 'home-a', id: `member-${index}` } }));
        const rows = new Map(members.map((member, index) => [member.key, createSessionListRenderableSessionFixture({
            id: member.ref.qualifiedId.id, active: true, activeAt: NOW, thinking: true, thinkingAt: NOW,
            metadata: { path: '/repo', host: 'test', homeDir: '/home/test', name: `Session ${index}` },
        })]));
        const refs = members.map(member => member.ref);
        let run = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'changed-run', state: 'running' }), null);
        members.push(member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: run.id } }));
        const projectSources = createBoardSessionSourceProjection();
        let sourceState = { sessionListRowsByServerId: { 'home-a': Object.fromEntries([...rows.values()].map(row => [row.id, row])) },
            deletedSessionIds: {}, concurrentSessionListCacheByServerId: {}, sessionListRenderableDelta: {
                revision: 1, changedSessionIds: [...rows.values()].map(row => row.id), removedSessionIds: [] as string[], rebuiltSessionListIndex: false,
            } };
        const context = {};
        // Observe the fixture lookup itself. The same canonical Home/key owners used by the
        // live facts reader stay real; no domain module is mocked for this measurement.
        const keyFor = (ref: BoardItemRefV1) => buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: {
            serverId: resolveServerProfileScopeIdForIdentifier(ref.qualifiedId.serverId) || ref.qualifiedId.serverId,
            id: ref.qualifiedId.id,
        } });
        let lookups = 0;
        let missingReasonLookups = 0;
        let accountLookups = 0;
        let facts: BoardCardFacts & { sessionInputs: { source: ReturnType<typeof projectSources>; context: object } } = {
            sessionInputs: { source: projectSources(sourceState, refs), context },
            inputContexts: { workflow_run: {} },
            nowMs: NOW, session: ref => { lookups += 1; return rows.get(keyFor(ref)) ?? null; },
            workflowRun: () => run, workflow: () => null, machine: () => null, machineSessionCounts: new Map(),
            accountScopedHome: serverId => { accountLookups += 1; return areServerProfileIdentifiersEquivalent('home-a', serverId); },
            missingEntityReason: ref => { missingReasonLookups += 1; keyFor(ref); return null; } };
        const project = createBoardCardProjection();
        const mountStarted = performance.now();
        let previous = project(members, facts);
        const mount = { ms: performance.now() - mountStarted, lookups, missingReasonLookups, accountLookups };
        const arrivals: Array<{ ms: number; lookups: number; missingReasonLookups: number; accountLookups: number }> = [];
        for (let index = 0; index < 20; index += 1) {
            const member = members[index]!;
            const before = rows.get(member.key)!;
            const changed = { ...before, metadata: { ...before.metadata!, name: `Updated Session ${index}` } };
            rows.set(member.key, changed);
            sourceState = { ...sourceState, sessionListRowsByServerId: { 'home-a': {
                ...sourceState.sessionListRowsByServerId['home-a'], [changed.id]: changed,
            } }, sessionListRenderableDelta: { ...sourceState.sessionListRenderableDelta,
                revision: sourceState.sessionListRenderableDelta.revision + 1, changedSessionIds: [changed.id] } };
            facts = { ...facts, sessionInputs: { source: projectSources(sourceState, refs), context } };
            lookups = 0;
            missingReasonLookups = 0;
            accountLookups = 0;
            const started = performance.now();
            const next = project(members, facts);
            arrivals.push({ ms: performance.now() - started, lookups, missingReasonLookups, accountLookups });
            expect(next.filter((card, position) => card !== previous[position]).map(card => card.key)).toEqual([member.key]);
            previous = next;
        }
        const durations = arrivals.map(arrival => arrival.ms).sort((a, b) => a - b);
        console.info('Board scalar input measurement', { mount,
            arrivals: { count: arrivals.length, lookupCounts: [...new Set(arrivals.map(arrival => arrival.lookups))],
                missingReasonLookupCounts: [...new Set(arrivals.map(arrival => arrival.missingReasonLookups))],
                accountLookupCounts: [...new Set(arrivals.map(arrival => arrival.accountLookups))],
                minMs: durations[0], medianMs: durations[Math.floor(durations.length / 2)], maxMs: durations.at(-1) } });
        expect(Math.max(...arrivals.map(arrival => arrival.lookups))).toBeLessThanOrEqual(2);
        expect(Math.max(...arrivals.map(arrival => arrival.missingReasonLookups))).toBeLessThanOrEqual(1);
        expect(Math.max(...arrivals.map(arrival => arrival.accountLookups))).toBeLessThanOrEqual(1);
        run = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: run.id, state: 'succeeded' }), null);
        facts = { ...facts, inputContexts: { workflow_run: {} } };
        lookups = 0;
        const afterRun = project(members, facts);
        expect(afterRun.filter((card, index) => card !== previous[index]).map(card => card.ref.qualifiedId.id)).toEqual([run.id]);
        expect(lookups).toBe(0);
    });

    it('keeps incremental Machine counts equivalent across reassociation, archival, Home qualification, gaps and expiry', () => {
        const project = createBoardMachineSessionProjection();
        const delta = (revision: number, changedSessionIds: string[], removedSessionIds: string[] = []) =>
            ({ revision, changedSessionIds, removedSessionIds, rebuiltSessionListIndex: false });
        let rows = { 'home-a': { same: { ...workingSession, id: 'same' } },
            'home-b': { same: { ...permissionSession, id: 'same' } } };
        const full = (now = NOW) => countSessionsByMachine(Object.entries(rows).map(([home, bucket]) => [home, Object.values(bucket)] as const), now);
        const initial = project.update(rows, delta(1, ['same']), NOW);
        expect(initial.counts).toEqual(full());
        const homeB = buildWorkBoardItemKeyV1({ kind: 'machine', qualifiedId: { serverId: 'home-b', id: 'm1' } });
        rows = { ...rows, 'home-a': { same: { ...rows['home-a'].same, metadata: { ...workingSession.metadata!, machineId: 'm2' } } } };
        const moved = project.update(rows, delta(2, ['same']), NOW);
        expect(moved.counts).toEqual(full());
        expect(moved.counts.get(homeB)).toBe(initial.counts.get(homeB));
        rows = { ...rows, 'home-b': { same: { ...rows['home-b'].same, archivedAt: NOW } } };
        expect(project.update(rows, delta(3, ['same']), NOW).counts).toEqual(full());
        rows = { ...rows, 'home-b': { same: { ...permissionSession, id: 'same' } } };
        expect(project.update(rows, delta(5, ['same']), NOW).counts).toEqual(full());
        const deadline = readSessionStatusNextRefreshAtMs(rows['home-a'].same, NOW)!;
        expect(project.read(deadline + 1).counts).toEqual(full(deadline + 1));
        const removed = { ...rows, 'home-a': {} };
        const remaining = countSessionsByMachine(Object.entries(removed).map(([home, bucket]) => [home, Object.values(bucket)] as const), deadline + 1);
        expect(project.update(removed, delta(6, [], ['same']), deadline + 1).counts).toEqual(remaining);
        expect(project.update(removed, undefined, deadline + 1).counts).toEqual(remaining);
    });

    it('publishes no partial counts or status work until membership settles, then retains equal summaries', () => {
        const members = Array.from({ length: 1000 }, (_, index) => member({ kind: 'session',
            qualifiedId: { serverId: 'home-a', id: `session-${index}` } }));
        let reads = 0;
        const facts: BoardCardFacts = { nowMs: NOW, session: () => { reads += 1; return permissionSession; },
            workflowRun: () => null, workflow: () => null, machine: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardSummaryProjection();
        const pending = project(members.slice(0, 3), facts, 0, false);
        expect(pending).toEqual({ itemCount: null, needYou: null, undetermined: null });
        expect(project(members, facts, 0, false)).toBe(pending);
        expect(reads).toBe(0);
        const settled = project(members, facts, 0, true);
        expect(settled).toEqual({ itemCount: 1000, needYou: 1000, undetermined: { count: 0, reasons: [] } });
        expect(project(members, facts, 0, true)).toBe(settled);
        const undetermined = { count: 2, reasons: [{ kind: 'session' as const, reason: 'project_association_unavailable' as const, count: 2 }] };
        const partial = project(members, facts, 0, true, undetermined);
        expect(partial).toEqual({ itemCount: 1000, needYou: 1000, undetermined });
        expect(project(members, facts, 0, true, { ...undetermined, reasons: [...undetermined.reasons] })).toBe(partial);
        expect(describeBoardSummaryLine(pending)).toEqual({ needYou: 0, text: '' });
    });
    it('words unresolved candidates once and makes every proven count a floor', () => {
        const sessions = { count: 2, reasons: [{ kind: 'session' as const, reason: 'project_association_unavailable' as const, count: 2 }] };
        expect(describeBoardSummaryLine({ needYou: 3, itemCount: 9, undetermined: sessions }))
            .toEqual({ needYou: 3, text: 'boards.meta.needYouAtLeast:3 · boards.meta.itemsAtLeast:9' });
        expect(describeBoardSummaryLine({ needYou: 0, itemCount: 9, undetermined: { count: 0, reasons: [] } }).text).toBe('boards.meta.items:9');
        expect(describeBoardSummaryLine({ needYou: 0, itemCount: 0, undetermined: sessions }).text).toBe('boards.empty.uncheckedTitle');
        expect(describeBoardUndetermined(sessions)).toEqual({ headline: 'boards.undetermined.sessions:2', reason: 'boards.undetermined.projectAssociation' });
        expect(describeBoardUndetermined({ count: 3, reasons: [
            { kind: 'session', reason: 'filter_facts_unavailable', count: 2 }, { kind: 'workflow_run', reason: 'filter_facts_unavailable', count: 1 },
        ] })).toEqual({ headline: 'boards.undetermined.items:3', reason: 'boards.undetermined.filterFacts' });
        expect(describeBoardUndetermined({ count: 1, reasons: [{ kind: 'workflow_run', reason: 'filter_facts_unavailable', count: 1 }] })?.headline)
            .toBe('boards.undetermined.runs:1');
        expect(describeBoardUndetermined({ count: 0, reasons: [] })).toBeNull();
        expect(describeBoardUndetermined(null)).toBeNull();
    });
    it('reprojects withdrawn Machine presence from offline to unknown without changing its retained row', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const machine = createMachineFixture({ id: 'mbp', active: false, activeAt: 1 });
        const scope = { serverId: 'home-a', accountId: 'owner' };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => machine, machineScope: () => scope, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('offline');
        withdrawMachinePresenceForScope(scope);
        expect(project([member(ref)], facts)[0]).toMatchObject({ body: { online: null },
            status: { bucket: 'idle', word: 'common.unknown' } });
        captureMachinePresenceObservation(scope)([machine.id]);
        expect(project([member(ref)], facts)[0]).toMatchObject({ body: { online: false }, status: { bucket: 'offline' } });
    });
    it('settles linked-task status with its Session read and recovers without replacing the task', () => {
        const ref = { kind: 'task', qualifiedId: { serverId: 'home-a', id: 'issue-cold' }, pluginId: 'com.acme.tasks' } as const;
        const task = { title: 'Cold linked work', category: 'completed' as const,
            linkedSessions: [{ serverId: 'home-a', sessionId: permissionSession.id }] };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, task: () => task,
            workflowRun: () => null, machine: () => null, workflow: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)).toEqual([]);
        const settled = { ...facts, missingEntityReason: (item: BoardItemRefV1) => item.kind === 'session' ? 'read failed' : null };
        expect(project([member(ref)], settled)[0]).toMatchObject({ availability: 'ready', title: task.title,
            status: { bucket: 'offline' } });
        expect(project([member(ref)], { ...settled, session: () => permissionSession })[0]?.status.bucket).toBe('needs_you');
    });

    it('keeps external task cards, uses linked-agent status, and refreshes that status without changing task facts', () => {
        const ref = { kind: 'task', qualifiedId: { serverId: 'home-a', id: 'issue-7' }, pluginId: 'com.acme.tasks' } as const;
        const task = { title: 'Fix payments', category: 'backlog' as const, categoryLabel: 'Backlog',
            linkedSessions: [{ serverId: 'home-a', sessionId: permissionSession.id }] };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => permissionSession, workflowRun: () => null,
            machine: () => null, workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
            task: () => task };
        const project = createBoardCardProjection();
        const cards = project([member(ref)], facts);
        expect(cards[0]).toMatchObject({ title: 'Fix payments', availability: 'ready', status: { bucket: 'needs_you' } });
        expect(project([member(ref)], { ...facts, session: () => workingSession })[0]?.status.bucket).toBe('working');
        expect(buildBoardCards([member(ref)], { ...facts, task: () => ({ ...task, linkedSessions: [] }) })[0]?.status)
            .toMatchObject({ bucket: 'idle', word: 'Backlog' });
        const unavailable = buildBoardCards([member(ref)], { ...facts, task: () => null,
            missingEntityReason: () => 'boards.card.unavailable' })[0];
        expect(unavailable).toMatchObject({ ref, availability: 'content_unavailable' });
    });

    it('binds Session settlement to its exact Home while retaining a real row over a tombstone', async () => {
        const serverId = 'srv_board_source';
        const profile = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverId,
            canonicalServerUrl: 'https://board-source.example.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://board-source.example.test' }],
        }, source: 'manual' });
        const ref = { kind: 'session' as const, qualifiedId: { serverId, id: 'uncached' } };
        const cold = { sessionListRowsByServerId: {}, deletedSessionIds: {}, concurrentSessionListCacheByServerId: {} };
        expect(readBoardSessionSourceState(cold, ref)).toBe('loading');
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: 'other' }, concurrentSessionListCacheByServerId: {
            other: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        } }, ref)).toBe('loading');
        const warm = { ...cold, concurrentSessionListCacheByServerId: {
            [profile.id]: { serverName: null, listObservation: { phase: 'refreshing' as const, lastSuccessAt: 1 } },
        } };
        expect(readBoardSessionSourceState(warm, ref)).toBe('settled');
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: profile.id } }, ref)).toBe('retired');
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id, archivedAt: 1 });
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: profile.id },
            sessionListRowsByServerId: { [profile.id]: { [row.id]: row } },
        }, ref)).toBe('ready');
        expect(readBoardSessionSourceState({ ...cold, concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'error', lastSuccessAt: null } },
        } }, ref)).toBe('failed');
    });

    it('binds Machine settlement to applied canonical inventory and retains its cached row during refresh', () => {
        const ref = { kind: 'machine' as const, qualifiedId: { serverId: 'home-a', id: 'machine' } };
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': null },
            machineListStatusByServerId: { 'home-a': 'loading' } }, ref)).toBe('loading');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': [] },
            machineListStatusByServerId: { 'home-a': 'idle' } }, ref)).toBe('settled');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': [createMachineFixture({ id: 'machine' })] },
            machineListStatusByServerId: { 'home-a': 'loading' } }, ref)).toBe('ready');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': null },
            machineListStatusByServerId: { 'home-a': 'signedOut' } }, ref)).toBe('settled');
    });

    it('keeps Workflow and Run refs loading through pages and settles exhausted or failed readers', () => {
        const source = { status: 'loaded' as const, hasMore: true, loadingMore: false, loadMoreFailed: false };
        expect(readBoardPagedEntitySourceState(source)).toBe('loading');
        expect(shouldLoadNextBoardEntityPage(source, true)).toBe(true);
        expect(shouldLoadNextBoardEntityPage(source, false)).toBe(false);
        expect(shouldLoadNextBoardEntityPage({ ...source, loadingMore: true }, true)).toBe(false);
        expect(readBoardPagedEntitySourceState({ ...source, hasMore: false })).toBe('settled');
        const failed = { ...source, loadMoreFailed: true };
        expect(readBoardPagedEntitySourceState(failed)).toBe('settled');
        expect(shouldLoadNextBoardEntityPage(failed, true)).toBe(false);
        expect(readBoardPagedEntitySourceState({ ...source, status: 'failed' })).toBe('settled');
    });

    it('reprojects request failure and recovery for the machine own Home and Account without a machine row update', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const machine = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const scope = { serverId: 'home-a', accountId: 'owner' };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => machine, machineScope: () => scope, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: true });
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: NOW });
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: false });
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('offline');
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: NOW + 1 });
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: true });
        expect(project([member(ref)], { ...facts, machineScope: () => null })[0]?.body).toMatchObject({ online: null });
    });
    it('keeps the enrolled Machine asleep and reprojects observed Start through the shared status owner', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'guest' } } as const;
        const managed: ManagedMachineV1 = { id: 'managed', homeId: 'home-a', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: { id: 'retained-native' } },
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } };
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const members = [member(ref)];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => guest, managedMachine: () => managed,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project(members, facts)[0]?.status).toMatchObject({ bucket: 'idle', word: 'managedPower.asleep' });
        const starting = { ...managed, submittedNativeEffect: { intent: 'start' as const, intentRevision: 2, requestId: 'start', controller: managed.controller } };
        expect(project(members, { ...facts, managedMachine: () => starting })[0]?.status).toMatchObject({ bucket: 'working', word: 'managedWake.starting' });
    });
    it('names why an online Machine needs the person in its state word, not its presence', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const mbp = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => mbp, machineScope: () => ({ serverId: 'home-a', accountId: 'owner' }), machineSessionCounts: new Map([[member(ref).key, { running: 2, needsYou: 1 }]]), accountScopedHome: () => true };
        expect(buildBoardCards([member(ref)], facts)[0]?.status)
            .toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'boards.card.machine.needYou:1' });
        const calm = buildBoardCards([member(ref)], { ...facts, machineSessionCounts: new Map([[member(ref).key, { running: 2, needsYou: 0 }]]) });
        expect(calm[0]?.status).toMatchObject({ bucket: 'working', tone: 'neutral', word: 'boards.card.machine.online' });
    });
    it('keeps unreadable Session explanations in the body with a short neutral state word', () => {
        const row = createSessionListRenderableSessionFixture({ ...permissionSession,
            hasPendingPermissionRequests: false, pendingRequestObservedAt: null, metadata: null,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' });
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: row.id } })], {
            nowMs: NOW, session: () => row, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        });
        expect(card?.status).toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'boards.card.unavailable' });
        expect(card?.body).toMatchObject({ kind: 'session', statusDetail: 'session.access.unavailable' });
        // No readable title exists, so the card is named by its kind rather than by a placeholder session name.
        expect(card?.title).toBe('boards.kinds.session');
    });
    it('gives an unreadable Session of unknown state one reason instead of a bare Unavailable', () => {
        const row = createSessionListRenderableSessionFixture({ ...permissionSession, metadata: null,
            encryptionMode: 'e2ee', encryptedContentAvailability: null });
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: row.id } })], {
            nowMs: NOW, session: () => row, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        });
        expect(card?.title).toBe('boards.kinds.session');
        expect(card?.status.word).toBe('boards.card.unavailable');
        expect(card?.body).toMatchObject({ kind: 'session', statusDetail: 'boards.card.readFailed' });
    });
    it('reprojects unchanged Session sources when the canonical status freshness deadline passes', () => {
        const members = [member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: workingSession.id } })];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => workingSession, workflowRun: () => null,
            machine: () => null, workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        const before = project(members, facts);
        expect(before[0]?.status.bucket).toBe('working');
        const refreshAt = readSessionStatusNextRefreshAtMs(workingSession, NOW);
        expect(refreshAt).not.toBeNull();
        const expired = { ...facts, nowMs: refreshAt! + 1 };
        expect(project(members, expired)[0]?.status).toEqual(buildBoardCards(members, expired)[0]?.status);
        expect(project(members, expired)[0]?.status.bucket).not.toBe('working');
        // Age does not acknowledge an outstanding request while its runtime remains live.
        expect(buildBoardCards(members, { ...expired, session: () => permissionSession })[0]?.status.bucket).toBe('needs_you');
    });
    it('projects FIN lean authored-step and loop progress without opening full runs', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflow: () => null, accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                stepProgress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
            }), null),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            kind: 'workflow_run', progress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
        });
        const missing = buildBoardCards([member(ref)], { ...facts,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ stepProgress: null }), null) });
        expect(missing[0]?.body).toMatchObject({ progress: null });
    });

    it('uses the same owner-projected failure acknowledgement and live hold facts for Run cards', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, machine: () => null,
            machineSessionCounts: new Map(), workflow: () => null, accountScopedHome: () => true, workflowRun: () => null };
        const status = (flags: { failureUnseen: boolean; invocationAttentionRequired: boolean; attentionRequired: boolean }) =>
            buildBoardCards([member(ref)], { ...facts, workflowRun: () => workflowRunRowFromSummary({
                ...createWorkflowRunSummaryFixture({ state: 'failed', heldCount: 9 }), ...flags,
            }, null) })[0]?.status;
        expect(status({ failureUnseen: true, invocationAttentionRequired: false, attentionRequired: true }))
            .toMatchObject({ state: 'failed', tone: 'danger', bucket: 'finished', attentionType: 'update' });
        expect(status({ failureUnseen: false, invocationAttentionRequired: false, attentionRequired: false }))
            .toMatchObject({ state: 'failed', tone: 'neutral', bucket: 'finished', attentionType: null });
        expect(status({ failureUnseen: false, invocationAttentionRequired: true, attentionRequired: true }))
            .toMatchObject({ tone: 'attention', bucket: 'needs_you', attentionType: 'decision' });
    });

    it('excludes failure Updates from Board Needs-you counts while retaining their rose status', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const cards = buildBoardCards([member(ref)], { nowMs: NOW, session: () => null, machine: () => null,
            machineSessionCounts: new Map(), workflow: () => null, accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                state: 'failed', failureUnseen: true, attentionRequired: true,
            }), null) });
        expect(cards[0]?.status).toMatchObject({ bucket: 'finished', tone: 'danger', attentionType: 'update' });
        expect(countBoardCardsNeedingYou(cards)).toBe(0);
    });

    it('retains the last Run owner status on a Workflow definition without opening that Run', () => {
        const ref = { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } } as const;
        const cards = buildBoardCards([member(ref)], { nowMs: NOW, session: () => null, machine: () => null,
            machineSessionCounts: new Map(), workflowRun: () => null, accountScopedHome: () => true,
            workflow: () => ({ title: 'Release check', summary: { needsYouCount: 0,
                lastRun: { ...createWorkflowRunRecentSummaryFixture({ state: 'failed', failureUnseen: true, attentionRequired: true }),
                    createdAt: '2026-10-01T00:00:00Z' } } }) });
        expect(cards[0]?.status).toMatchObject({ state: 'failed', tone: 'danger', attentionType: 'update' });
        expect(cards[0]?.body).toMatchObject({ kind: 'workflow', lastRunAt: '2026-10-01T00:00:00Z' });
        expect(countBoardCardsNeedingYou(cards)).toBe(0);
    });

    it('refreshes a Run pending Stop when its already-held Machine disconnects and reconnects', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const machine = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const scope = { serverId: 'home-a', accountId: 'owner' };
        observeMachinePresenceForTest(scope, [machine.id]);
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            state: 'cancelled', workflowCustodyState: 'pending', machineId: machine.id,
        }), null);
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, machine: () => machine,
            machineScope: () => scope, machineSessionCounts: new Map(), workflow: () => null,
            accountScopedHome: () => true, workflowRun: () => row };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('working');
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: NOW });
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('offline');
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: NOW + 1 });
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('working');
    });

    it('projects library trigger summaries and distinguishes manual from unavailable scheduled next-run facts', () => {
        const ref = { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflowRun: () => null, accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly', triggers: [{ kind: 'schedule', schedule: {
                kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null,
            } }], summary: { needsYouCount: 2, lastRun: { ...createWorkflowRunRecentSummaryFixture({ state: 'succeeded' }), createdAt: '2026-10-01T00:00:00Z', startedAt: '2026-10-01T00:00:00Z' } } }),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            triggerSummary: 'workflows.triggers.summary.everyHours:1', nextRun: { kind: 'unavailable' }, needsYouCount: 2,
        });
        const manual = buildBoardCards([member(ref)], { ...facts,
            workflow: () => ({ title: 'Manual', triggers: [], summary: { needsYouCount: 0, lastRun: null } }) })[0];
        expect(manual?.body)
            .toMatchObject({ triggerSummary: 'workflows.triggers.summary.manual', nextRun: { kind: 'unscheduled' }, needsYouCount: 0 });
    });

    it('withholds an item this device has not loaded yet, and keeps "unavailable" for a Home that is not connected', () => {
        const ref = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-late' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        };
        expect(buildBoardCards([member(ref)], facts)).toEqual([]);
        expect(buildBoardCards([member(ref, false)], facts)[0]).toMatchObject({
            availability: 'home_unavailable', title: 'boards.kinds.session', status: { word: 'boards.card.unavailable' },
        });
    });

    it('reprojects an absent entity when its binding settles without inventing a row', () => {
        const ref = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-missing' } } as const;
        const members = [member(ref)];
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        };
        const project = createBoardCardProjection();
        expect(project(members, facts)).toEqual([]);
        const settled = { ...facts, missingEntityReason: () => 'source answered without this item' };
        expect(project(members, settled)[0]).toMatchObject({ availability: 'content_unavailable',
            unavailableReason: 'source answered without this item', status: { bucket: 'offline', word: 'boards.card.unavailable' }, body: { kind: 'none' } });
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id });
        expect(project(members, { ...settled, session: () => row })[0]?.availability).toBe('ready');
    });

    it('counts running and needs-you sessions per machine from the loaded rows, through the shared status owner', () => {
        const machineKey = (serverId: string, id: string) => JSON.stringify(['machine', serverId, id]);
        // The same machine id on two Homes is two machines: each counts only its own Home's rows.
        const counts = countSessionsByMachine([
            ['home-a', [permissionSession, workingSession]],
            ['home-b', [{ ...workingSession, id: 's-work-b' }]],
        ], NOW);
        expect(counts.get(machineKey('home-a', 'm1'))).toEqual({ running: 1, needsYou: 1 });
        expect(counts.get(machineKey('home-b', 'm1'))).toEqual({ running: 1, needsYou: 0 });
    });

    it('gives every kind one status vocabulary and groups all kinds By status, Finished rather than Done', () => {
        const facts: BoardCardFacts = {
            nowMs: NOW,
            session: (ref) => (ref.qualifiedId.id === 's-need' ? permissionSession : null),
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'succeeded' }), null),
            machine: (ref) => (ref.qualifiedId.id === 'm1'
                ? createMachineFixture({ id: 'm1', active: true, activeAt: NOW })
                : createMachineFixture({ id: 'm2', active: false, activeAt: 1 })),
            machineScope: serverId => ({ serverId, accountId: 'owner' }),
            machineSessionCounts: new Map([[JSON.stringify(['machine', 'home-a', 'm1']), { running: 1, needsYou: 1 }]]),
            accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
        };
        const cards = buildBoardCards([
            member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-need' } }),
            member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm2' } }),
            member({ kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } }),
        ], facts);

        expect(cards.map((card) => [card.ref.kind, card.status.bucket])).toEqual([
            ['session', 'needs_you'],
            ['workflow_run', 'finished'],
            ['machine', 'needs_you'],
            ['machine', 'offline'],
            ['workflow', 'idle'],
        ]);
    });

    it('shows an item from a Home that is not mounted as unavailable, not as missing work', () => {
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-off', id: 's9' } }, false)], {
            nowMs: NOW,
            session: () => null,
            workflowRun: () => null,
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        expect(card!.availability).toBe('home_unavailable');
        expect(card!.status.bucket).toBe('offline');
    });

    it('never reads another Home\'s workflow or run from the focused Home\'s same-id item', () => {
        const run = (serverId: string) => member({ kind: 'workflow_run', qualifiedId: { serverId, id: 'r1' } });
        const workflow = (serverId: string) => member({ kind: 'workflow', qualifiedId: { serverId, id: 'wf1' } });
        const cards = buildBoardCards([run('home-a'), run('home-b'), workflow('home-a'), workflow('home-b')], {
            nowMs: NOW,
            session: () => null,
            // The Account-scoped stores hold the focused Home's (home-a) r1 and wf1, keyed by bare id.
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'running' }), null),
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
            accountScopedHome: (serverId) => serverId === 'home-a',
        });
        expect(cards.map((card) => [card.ref.qualifiedId.serverId, card.ref.kind, card.availability])).toEqual([
            ['home-a', 'workflow_run', 'ready'],
            ['home-b', 'workflow_run', 'home_unavailable'],
            ['home-a', 'workflow', 'ready'],
            ['home-b', 'workflow', 'home_unavailable'],
        ]);
    });

    it('on a populated board, a store update on one item gives a new card to that item only', () => {
        // 40 cards mixing kinds (INT §7.3); one Session then asks for a permission.
        const rows = new Map(Array.from({ length: 20 }, (_, index) => [`s${index}`, createSessionListRenderableSessionFixture({
            id: `s${index}`, active: true, activeAt: NOW, metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
        })] as const));
        const members = [
            ...Array.from({ length: 20 }, (_, index) => member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: `s${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: `r${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: `m${index}` } })),
        ];
        const facts = (sessionRows: ReadonlyMap<string, ReturnType<typeof createSessionListRenderableSessionFixture>>): BoardCardFacts => ({
            nowMs: NOW,
            session: (ref) => sessionRows.get(ref.qualifiedId.id) ?? null,
            workflowRun: (ref) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: ref.qualifiedId.id, state: 'running' }), null),
            machine: (ref) => createMachineFixture({ id: ref.qualifiedId.id, active: true, activeAt: NOW }),
            machineScope: serverId => ({ serverId, accountId: 'owner' }),
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        const before = buildBoardCards(members, facts(rows));
        expect(before).toHaveLength(40);
        const updated = new Map(rows);
        updated.set('s7', { ...rows.get('s7')!, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW });
        const after = reconcileBoardCards(before, buildBoardCards(members, facts(updated)));

        const changed = after.filter((card, index) => card !== before[index]);
        expect(changed.map((card) => card.ref.qualifiedId.id)).toEqual(['s7']);
        expect(changed[0]!.status.bucket).toBe('needs_you');
        // Nothing changed at all: the previous list itself is kept.
        expect(reconcileBoardCards(after, buildBoardCards(members, facts(updated)))).toBe(after);
    });

    it('says in the column what a board holds right now: who needs you, then how many items (lab boards-B1)', () => {
        const status = (bucket: 'needs_you' | 'working') => ({ state: bucket, attentionType: bucket === 'needs_you' ? 'decision' as const : null,
            bucket, tone: bucket === 'needs_you' ? 'attention' as const : 'neutral' as const, word: bucket });
        const cards = [status('needs_you'), status('needs_you'), status('working')].map((value, index) => ({
            key: `k${index}`,
            ref: { kind: 'session' as const, qualifiedId: { serverId: 'home-a', id: `s${index}` } },
            picked: true,
            availability: 'ready' as const,
            title: `s${index}`,
            status: value,
            body: { kind: 'none' as const },
        }));
        expect(describeBoardColumnLine(cards)).toEqual({ needYou: 2, text: 'boards.meta.needYou:2 · boards.meta.items:3' });
        expect(describeBoardColumnLine(cards.slice(2))).toEqual({ needYou: 0, text: 'boards.meta.items:1' });
    });
});

describe('describeBoardSummaryCounts (an index row whose body is not read)', () => {
    it('says what the saved layout holds, and nothing when the header has no layout', async () => {
        const { describeBoardSummaryCounts } = await import('./boardCards');
        expect(describeBoardSummaryCounts(null, [])).toBeUndefined();
        expect(describeBoardSummaryCounts({ widgets: 3, picked: 2, filtered: false }, [])).toBe('boards.meta.widgets:3 · boards.meta.items:2');
        expect(describeBoardSummaryCounts({ widgets: 1, picked: 0, filtered: true }, [])).toBe('boards.meta.widgets:1');
        // A hand-picked board with nothing on it says so; one that a filter or a section fills says nothing it can't know.
        expect(describeBoardSummaryCounts({ widgets: 0, picked: 0, filtered: false }, [])).toBe('boards.meta.handPicked · boards.meta.empty');
        expect(describeBoardSummaryCounts({ widgets: 0, picked: 0, filtered: true }, [])).toBeUndefined();
        expect(describeBoardSummaryCounts({ widgets: 0, picked: 0, filtered: false }, ['needs_you'])).toBeUndefined();
    });
});
