import { afterEach, expect, it, vi } from 'vitest';
import { createUsageQuerySessionInputs, type SessionInputEvidence } from './usageQuerySessionInputs';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsContributionSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageQueryEvidencePhase } from './usageQueryEvidencePhase';

afterEach(() => vi.restoreAllMocks());

it('reuses settled Session inputs without per-Session cancellation subscriptions and reads only a changed Session', async () => {
    // The loaded Account's complete phase contained 3,634 Sessions (FREEZE-3).
    const scope = { serverId: 'usage-settled-input-cost.test', accountId: 'account' };
    const previous = storage.getState();
    storage.setState({ profileScope: scope, sessions: {} });
    const controller = new AbortController();
    const owner = createUsageQuerySessionInputs({ lifetime: { scope, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) }, signal: controller.signal, assertCurrent() {} });
    const ids = Array.from({ length: 3_634 }, (_, index) => `session-${index}`);
    let accessFactReads = 0;
    const sessions = Object.fromEntries(ids.map(id => {
        const session = createSessionFixture({ id, encryptionMode: 'plain' });
        Object.defineProperty(session.access!.capabilities, 'submitAgentInput', {
            enumerable: true, get() { accessFactReads++; return true; },
        });
        return [id, session] as const;
    }));
    storage.setState({ sessions });
    let loads = 0;
    let asynchronousReads = 0;
    const values = new Map<string, SessionInputEvidence>();
    const read = async (id: string) => {
        const result = owner.read(id, false, async () => {
            loads++;
            const session = projectUsageSessionInput(storage.getState().sessions[id]!);
            return { session, callerDataKeyEnvelope: null, completeMessageCoverage: true,
                detail: { status: 'available', facts: [] } };
        }, value => { values.set(id, value); }, undefined, 'range', 'widget', controller.signal);
        if (result instanceof Promise) asynchronousReads++;
        const value = await result;
        if (value) values.set(id, value);
        return value;
    };
    const subscriptions = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    try {
        await Promise.all(ids.map(read));
        expect(loads).toBe(ids.length);
        const admitted = new Map(values);
        subscriptions.mockClear();
        loads = 0;
        asynchronousReads = 0;
        accessFactReads = 0;
        await Promise.all(ids.map(read));
        expect.soft(accessFactReads, 'a settled range does not traverse unchanged Session access facts').toBe(0);
        expect(loads, 'entering an already-read range acquires no Session inputs').toBe(0);
        expect(asynchronousReads, 'settled Session evidence returns directly without allocating per-Session continuations').toBe(0);
        expect(subscriptions.mock.calls.filter(([type]) => type === 'abort'),
            'settled work cannot be cancelled and must not subscribe once per Session on a view switch').toHaveLength(0);
        for (const id of ids) expect(values.get(id)).toBe(admitted.get(id));
        storage.setState({ sessions: { ...sessions,
            [ids[0]!]: createSessionFixture({ ...sessions[ids[0]!]!, seq: 2 }) } });
        expect(owner.reconcile([ids[0]!])).toBe(true);
        asynchronousReads = 0;
        await Promise.all(ids.map(read));
        expect(loads, 'one changed Session acquires one replacement input').toBe(1);
        expect(asynchronousReads, 'only the changed Session needs an asynchronous acquisition').toBe(1);
        expect(values.get(ids[0]!)?.session.seq).toBe(2);
        for (const id of ids.slice(1)) expect(values.get(id)).toBe(admitted.get(id));
        const changed = storage.getState().sessions[ids[0]!]!;
        storage.setState({ sessions: { ...storage.getState().sessions,
            [ids[0]!]: { ...changed, access: { ...changed.access!, capabilities: {
                ...changed.access!.capabilities, readTranscript: false,
            } } } } });
        expect(owner.reconcile([ids[0]!]), 'access-only changes invalidate the same Session input').toBe(true);
        loads = 0;
        asynchronousReads = 0;
        await Promise.all(ids.map(read));
        expect(loads, 'one changed access projection acquires one replacement input').toBe(1);
        expect(asynchronousReads).toBe(1);
        expect(values.get(ids[0]!)?.session.access?.capabilities.readTranscript).toBe(false);
        for (const id of ids.slice(1)) expect(values.get(id)).toBe(admitted.get(id));
    } finally {
        owner.dispose();
        controller.abort();
        storage.setState({ profileScope: previous.profileScope, sessions: previous.sessions });
    }
});

it('does no per-fact membership work for broad Coach and How projections, including a changed Session', async () => {
    const scope = { serverId: 'usage-selection-membership-cost.test', accountId: 'account' };
    const previous = storage.getState();
    storage.setState({ profileScope: scope, sessions: {} });
    const controller = new AbortController();
    const owner = createUsageQuerySessionInputs({ lifetime: { scope, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) }, signal: controller.signal, assertCurrent() {} });
    const ids = Array.from({ length: 64 }, (_, index) => `session-${index}`);
    const phase = new UsageQueryEvidencePhase(ids.length, true);
    const visits = ids.map(() => 0);
    let accountingRowReads = 0;
    let accountingTurnReads = 0;
    const contributions = ids.map(id => {
        const row = UsageAnalyticsContributionSchema.parse({ id, observedAtMs: 300, sessionId: id, turnId: 'turn',
            agentId: 'codex', modelId: null, machineId: 'machine', projectKey: 'historical-project', workspaceId: null, source: 'runtime',
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } });
        Object.defineProperty(row, 'sessionId', { get() { accountingRowReads++; return id; } });
        return row;
    });
    const admittedTurns = ids.map(id => ({ sessionId: id, get turnId() { accountingTurnReads++; return 'turn'; } }));
    let loads = 0;
    const load = async (index: number, terminalAt = 200) => {
        const id = ids[index]!;
        const value = await owner.read(id, true, async () => {
            loads++;
            const session = projectUsageSessionInput(createSessionFixture({ id, encryptionMode: 'plain',
                sessionTurns: { v: 1, sessionId: id, updatedAt: terminalAt,
                    turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
                        terminalAt, updatedAt: terminalAt }] } }));
            const detail = projectSessionUsageWorkEvidence(session);
            for (const fact of detail.facts ?? []) {
                const workId = fact.workId;
                Object.defineProperty(fact, 'workId', { get() { visits[index]!++; return workId; } });
            }
            return { session, detail, callerDataKeyEnvelope: null, completeMessageCoverage: true };
        }, undefined, undefined, 'broad-history');
        phase.select(id, value, true);
    };
    const coach = normalizeUsageQuery({ period: { relative: '90days' }, includeActivity: false });
    const how = normalizeUsageQuery({ ...coach, includeActivity: true });
    const project = (query = coach) => owner.projectSelection({ query, nowMs: 1_800_000_000_000, admitted: true,
        selected: phase.selected, selectedIds: ids, scope, currentScope: scope, isCurrent: true, contributions, admittedTurns });
    try {
        await Promise.all(ids.map((_, index) => load(index)));
        const initial = project();
        expect(initial.detail.facts).toHaveLength(ids.length);
        expect(visits, 'unfiltered private history needs no work-id admission lookup or known-work index').toEqual(ids.map(() => 0));
        expect.soft(accountingRowReads, 'broad detail does not consume historical accounting row membership').toBe(0);
        expect.soft(accountingTurnReads, 'broad detail does not consume admitted accounting turns').toBe(0);
        expect(project(how)).toBe(initial);
        visits.fill(0);
        loads = 0;
        owner.invalidateForHomeChange({ serverId: scope.serverId, source: 'socket',
            changeKinds: ['session'], entityIds: [ids[0]!] });
        await load(0, 300);
        expect(loads, 'the row-level producer re-admits only the changed Session').toBe(1);
        const changed = project(how);
        expect(changed).not.toBe(initial);
        expect(changed.detail.facts?.some(fact => fact.endMs === 300)).toBe(true);
        expect(changed.detail.facts?.filter(fact => fact.endMs === 200)).toHaveLength(ids.length - 1);
        expect(visits, 'a changed member still needs no per-fact membership walk of any Session').toEqual(ids.map(() => 0));
        expect.soft(accountingRowReads, 'a changed Session does not rebuild unused accounting row membership').toBe(0);
        expect.soft(accountingTurnReads, 'a changed Session does not rebuild unused accounting turn membership').toBe(0);
        expect(project(normalizeUsageQuery({ ...how, agents: ['codex'] })).detail.facts).toHaveLength(ids.length);
        expect(accountingRowReads, 'Agent-scoped detail still resolves historical accounting membership').toBeGreaterThan(0);
        expect(accountingTurnReads, 'Agent-scoped detail still admits accounting turns').toBeGreaterThan(0);
        expect(project(normalizeUsageQuery({ ...how, projects: ['historical-project'] })).detail.facts).toHaveLength(ids.length);
    } finally {
        owner.dispose();
        controller.abort();
        storage.setState({ profileScope: previous.profileScope, sessions: previous.sessions });
    }
});

it('projects only a query’s consumed Session facts when the shared evidence phase changes', async () => {
    const scope = { serverId: 'usage-selection-consumed-cost.test', accountId: 'account' };
    const previous = storage.getState();
    storage.setState({ profileScope: scope, sessions: {} });
    const controller = new AbortController();
    const owner = createUsageQuerySessionInputs({ lifetime: { scope, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) }, signal: controller.signal, assertCurrent() {} });
    const phase = new UsageQueryEvidencePhase(2, true);
    const query = normalizeUsageQuery({ session: 'selected' });
    let reads = 0;
    const selectedSession = projectUsageSessionInput(createSessionFixture({ id: 'selected', encryptionMode: 'plain' }));
    const detail = projectSessionUsageWorkEvidence(selectedSession);
    const facts = detail.facts;
    Object.defineProperty(detail, 'facts', { get() { reads++; return facts; } });
    const load = async (id: string, demand: string, persisted: boolean) => {
        const value = await owner.read(id, true, async (_assertCurrent, _signal, retained) => retained
            ? { ...retained, workFactsPersisted: persisted,
                ...(id === 'other' ? { session: projectUsageSessionInput(createSessionFixture({ id, encryptionMode: 'plain', seq: 2 })) } : {}) }
            : { session: id === 'selected' ? selectedSession
                : projectUsageSessionInput(createSessionFixture({ id, encryptionMode: 'plain' })),
                detail: id === 'selected' ? detail : { status: 'available', facts: [] },
                callerDataKeyEnvelope: null, completeMessageCoverage: true, workFactsPersisted: persisted },
        undefined, undefined, demand);
        phase.select(id, value, true);
    };
    const project = () => owner.projectSelection({ query, nowMs: 1_000, admitted: true,
        selected: phase.selected, selectedIds: ['selected'], scope, currentScope: scope, isCurrent: true,
        admittedTurns: [] });
    try {
        await load('selected', 'selected', false);
        await load('other', 'other', true);
        const initial = project();
        reads = 0;
        owner.invalidateForHomeChange({ serverId: scope.serverId, source: 'socket',
            changeKinds: ['session'], entityIds: ['other'] });
        await load('other', 'other', true);
        const afterSibling = project();
        expect(reads, 'a sibling query’s changed input does not merge this query’s unchanged facts').toBe(0);
        expect(afterSibling).toBe(initial);
        await load('selected', 'selected', true);
        expect(project()).toBe(initial);
        expect(reads, 'persisting admitted compact facts changes read status, not projected private content').toBe(0);
    } finally {
        owner.dispose();
        controller.abort();
        storage.setState({ profileScope: previous.profileScope, sessions: previous.sessions });
    }
});
