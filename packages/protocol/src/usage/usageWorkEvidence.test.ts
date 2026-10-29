import { describe, expect, it } from 'vitest';
import { projectSessionUsageWorkEvidence, projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds,
    usageQueryNeedsSessionCandidates } from './usageWorkEvidence.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsageCollaboration } from './usageCollaboration.js';
import { SessionAwarenessOriginV1Schema } from '../sessions/awareness/projectionV1.js';
import { UsageAnalyticsContributionSchema } from './usageAnalyticsContracts.js';

const turns = { v: 1 as const, sessionId: 'parent', updatedAt: 900, turns: [
    { turnId: 'old', agentId: 'claude', status: 'completed' as const, startedAt: 100, terminalAt: 500, updatedAt: 500 },
    { turnId: 'new', agentId: 'codex', status: 'in_progress' as const, startedAt: 600, updatedAt: 900 },
] };
const session = { id: 'parent', metadata: { machineId: 'machine' }, agentState: null, sessionTurns: turns };
const tool = (id: string, name: string, input: unknown, createdAt = 200) => ({ id, createdAt,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: id, name, input } } } });
const contribution = (sessionId: string, turnId: string) => UsageAnalyticsContributionSchema.parse({
    id: JSON.stringify([sessionId, turnId]), observedAtMs: 300, sessionId, turnId,
    agentId: 'claude', modelId: null, machineId: 'machine', projectKey: null, workspaceId: null, source: 'runtime',
    tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 14 },
    cost: { reportedUsd: 1, estimatedUsd: 2, invoiceUsd: 3, currency: 'USD' },
});

describe('Usage shared work evidence', () => {
    it('admits only execution-witnessed turns and never acquires the whole Session population for that selection', () => {
        const query = normalizeUsageQuery({ execution: 'happier' });
        const contributions = [{ ...contribution('parent', 'old'), sourceContext: { path: 'native' as const, execution: 'happier' as const } },
            contribution('parent', 'new')];
        expect(usageQueryNeedsSessionCandidates(query)).toBe(false);
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [session], contributions })).toEqual(['parent']);
        const detail = projectUsageQueryWorkEvidence({ query, sessions: [session], contributions });
        expect(detail.closedTurns?.map(row => row.workId)).toEqual(['["parent","old"]']);
        expect(projectUsageQueryWorkEvidence({ query, sessions: [session], contributions: [contribution('parent', 'new')] }))
            .toEqual({ status: 'unknown' });
    });
    it('intersects public detail with exact admitted turns rather than the whole mixed Session', () => {
        const query = normalizeUsageQuery({ population: 'public_eligible_personal' });
        const contributions = [contribution('parent', 'old')];
        const mixed = { ...session, agentState: { completedRequests: {
            eligible: { tool: 'Read', turnId: 'old', createdAt: 200, completedAt: 250, status: 'approved' },
            excluded: { tool: 'Read', turnId: 'new', createdAt: 700, completedAt: 750, status: 'approved' },
        } } };
        const openedMessages = new Map([['parent', [tool('eligible-child', 'SubAgent', { sidechainId: 'eligible' }, 200),
            tool('excluded-child', 'SubAgent', { sidechainId: 'excluded' }, 700)]]]);
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [mixed, { id: 'unrelated' }], contributions })).toEqual(['parent']);
        const detail = projectUsageQueryWorkEvidence({ query, sessions: [mixed], openedMessages, contributions });
        expect(detail.closedTurns?.map(row => row.workId)).toEqual(['["parent","old"]']);
        expect(detail.facts?.map(row => row.workId)).toEqual(['["parent","old"]', '["parent","old"]']);
        expect(detail.permissions?.map(row => row.requestId)).toEqual(['eligible']);
        expect(detail.collaboration?.map(row => row.targetId)).toEqual(['sidechain:parent:eligible']);
        expect(detail.activityAtMs).toEqual([100]);
        // Ordinary personal history retains existing Session-wide detail admission.
        const ordinary = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({}), sessions: [mixed], openedMessages, contributions });
        expect(ordinary.closedTurns).toHaveLength(2);
        expect(ordinary.permissions).toHaveLength(2);
        expect(ordinary.collaboration).toHaveLength(2);
    });

    it('does not acquire or project public Session detail when exact accounting turns are unavailable', () => {
        const query = normalizeUsageQuery({ population: 'public_eligible_personal', session: 'parent' });
        expect(usageQueryNeedsSessionCandidates(query)).toBe(false);
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [session] })).toEqual([]);
        expect(projectUsageQueryWorkEvidence({ query, sessions: [session] })).toEqual({ status: 'unknown' });
    });

    it('cannot derive a public replay launcher from an excluded turn in an otherwise admitted source Session', () => {
        const child = { ...session, id: 'child', metadata: { forkV1: { parentSessionId: 'parent', createdAtMs: 200 } },
            sessionTurns: { ...turns, sessionId: 'child', turns: [{ ...turns.turns[0]!, agentId: 'codex' }] } };
        const contributions = [contribution('parent', 'new'), contribution('child', 'old')];
        const query = normalizeUsageQuery({ population: 'public_eligible_personal' });
        // The UI retains Session projections, not the outward query's historical joins.
        const sessionEvidence = new Map([session, child].map(value => [value.id, projectSessionUsageWorkEvidence(value)]));
        const previouslyAdmitted = projectUsageQueryWorkEvidence({ query, sessions: [session, child], sessionEvidence,
            contributions: [contribution('parent', 'old'), contribution('child', 'old')] });
        expect(previouslyAdmitted.collaboration?.[0]?.sourceAgentId).toBe('claude');
        const detail = projectUsageQueryWorkEvidence({ query, sessions: [session, child], contributions, sessionEvidence });
        expect(detail.collaboration).toEqual([expect.objectContaining({ relation: 'replay', sourceSessionId: 'parent',
            sourceAgentId: null, targetAgentId: 'codex' })]);
    });

    it('retains real closed-turn observations including open status without inventing duration', () => {
        expect(projectSessionUsageWorkEvidence(session)).toMatchObject({ closedTurns: [
            { workId: '["parent","old"]', agentId: 'claude', startMs: 100, endMs: 500, status: 'completed' },
            { workId: '["parent","new"]', agentId: 'codex', startMs: 600, endMs: null, status: 'in_progress' },
        ] });
    });
    it('projects witnessed run/native identities once and never stores labels, instructions or current Agent guesses', () => {
        const input = { runId: 'run-one', sidechainId: 'side-one', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            launchOrigin: { kind: 'session', sessionId: 'parent' }, instructions: 'private instructions', label: 'private label' };
        const native = { threadId: 'child-thread', parentThreadId: 'parent-thread', providerTurnId: 'child-turn', sidechainId: 'child-thread' };
        const detail = projectSessionUsageWorkEvidence(session, [tool('run-call', 'SubAgentRun', input), tool('duplicate-native', 'SubAgent', { sidechainId: 'side-one' }),
            tool('native-call', 'SubAgent', native), tool('native-call', 'SubAgent', native),
            tool('unbound-call', 'SubAgentRun', { ...input, runId: 'unbound', sidechainId: 'unbound', intent: 'delegate', launchOrigin: { kind: 'external' } }, 550)]);
        expect(detail).toMatchObject({ collaboration: expect.arrayContaining([
            expect.objectContaining({ relation: 'review', targetId: 'run:run-one', sourceAgentId: 'claude', targetAgentId: 'codex', workId: '["parent","old"]' }),
            expect.objectContaining({ relation: 'native', targetId: 'sidechain:parent:child-thread', targetAgentId: 'codex' }),
            expect.objectContaining({ relation: 'run', targetId: 'run:unbound', sourceAgentId: null, sourceSessionId: null }),
        ]) });
        expect(detail.collaboration).toHaveLength(3);
        expect(JSON.stringify(detail)).not.toMatch(/private instructions|private label|parent-thread/);
    });
    it('keeps birth, reporting, replay and moved work distinct with missing historical identities Unknown', () => {
        const birth = projectSessionUsageWorkEvidence({ ...session, createdAt: 200, origin: { kind: 'session' }, manager: { sessionId: 'new-manager' } });
        expect(birth.collaboration).toEqual([
            expect.objectContaining({ relation: 'spawn', sourceAgentId: null, sourceSessionId: null, observedAtMs: 200 }),
            expect.objectContaining({ relation: 'report', observedAtMs: null }),
        ]);
        const detail = projectSessionUsageWorkEvidence({ ...session, createdAt: 200, origin: { kind: 'session' }, manager: { sessionId: 'new-manager' },
            metadata: { ...session.metadata, forkV1: { parentSessionId: 'source', createdAtMs: 250 },
                handoffV1: { sourceMachineId: 'a', targetMachineId: 'b', agentId: 'claude', completedAtMs: 300 } } });
        expect(detail).toMatchObject({ collaboration: [
            expect.objectContaining({ relation: 'report', sourceSessionId: 'parent', targetId: 'session:new-manager', observedAtMs: null }),
            expect.objectContaining({ relation: 'replay', sourceSessionId: 'source', observedAtMs: 250 }),
            expect.objectContaining({ relation: 'handoff', sourceAgentId: 'claude', targetAgentId: 'claude', observedAtMs: 300 }),
        ] });
    });
    it.each(['native-first', 'run-first'] as const)('deduplicates witnessed native and host Run across retained pages (%s)', order => {
        const native = tool('native-call', 'SubAgent', { sidechainId: 'shared-child' });
        const run = tool('run-call', 'SubAgentRun', { runId: 'retained-run', sidechainId: 'shared-child', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, launchOrigin: { kind: 'session', sessionId: 'parent' } });
        const first = projectSessionUsageWorkEvidence(session, [order === 'native-first' ? native : run]);
        const second = projectSessionUsageWorkEvidence(session, [order === 'native-first' ? run : native], {
            messageEvidence: { ...first, collaboration: first.collaboration },
        });
        expect(second.collaboration).toEqual([expect.objectContaining({ relation: 'review', targetId: 'run:retained-run' })]);
    });
    it('reads historical structured Run evidence from a JSON-encoded transcript result', () => {
        const launch = tool('encoded-call', 'SubAgentRun', { instructions: 'private instructions' }, 700);
        const result = { id: 'encoded-result', createdAt: 710, content: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call-result', callId: 'encoded-call', output: JSON.stringify({ runId: 'encoded-run', sidechainId: 'encoded-sidechain',
                intent: 'review', startedAtMs: 200, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                launchOrigin: { kind: 'session', sessionId: 'parent' } }),
        } } } };
        const detail = projectSessionUsageWorkEvidence(session, [launch, result]);
        expect(detail.collaboration).toEqual([expect.objectContaining({ relation: 'review', observedAtMs: 200,
            sourceAgentId: 'claude', targetAgentId: 'codex' })]);
    });
    it('filters closed turns and relations with the same historical work membership as intervals', () => {
        const detail = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ agents: ['claude'] }), sessions: [session],
            openedMessages: new Map([['parent', [tool('a', 'SubAgent', { sidechainId: 'a' }), tool('b', 'SubAgent', { sidechainId: 'b' }, 700)]]]) });
        expect(detail.closedTurns).toHaveLength(1);
        expect(detail.collaboration).toHaveLength(1);
        expect(detail.collaboration?.[0]).toMatchObject({ workId: '["parent","old"]' });
    });
    it('counts Claude native child execution only when the native sidechain witnesses the launch', () => {
        const launch = { id: 'launch', createdAt: 200, content: { role: 'agent', content: { type: 'output', data: {
            type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task', name: 'Task', input: { prompt: 'private prompt' } }] },
        } } } };
        const child = { id: 'child', createdAt: 210, content: { role: 'agent', content: { type: 'output', data: {
            type: 'assistant', parent_tool_use_id: 'task', message: { role: 'assistant', content: [{ type: 'text', text: 'private child response' }] },
        } } } };
        expect(projectSessionUsageWorkEvidence(session, [launch]).collaboration).toEqual([]);
        const detail = projectSessionUsageWorkEvidence(session, [launch, child]);
        expect(detail.collaboration).toEqual([expect.objectContaining({ relation: 'native', sourceAgentId: 'claude',
            targetAgentId: 'claude', targetId: 'sidechain:parent:task' })]);
        expect(JSON.stringify(detail)).not.toMatch(/private prompt|private child response/);
    });
    it('uses the original launch when a resumed run repeats its identity in a later turn', () => {
        const input = { runId: 'resumed', sidechainId: 'resumed', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            launchOrigin: { kind: 'session', sessionId: 'parent' } };
        const detail = projectSessionUsageWorkEvidence(session, [tool('first', 'SubAgentRun', input, 200), tool('resumed', 'SubAgentRun', input, 700)]);
        expect(resolveUsageCollaboration({ facts: detail.collaboration ?? [], period: { startMs: 100, endMs: 500 } }).edges)
            .toEqual([{ sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'review', count: 1 }]);
        expect(resolveUsageCollaboration({ facts: detail.collaboration ?? [], period: { startMs: 600, endMs: 900 } }).edges).toEqual([]);
    });
    it('joins replay launcher identity only from the source Session already admitted to the same query', () => {
        const child = { ...session, id: 'child', origin: SessionAwarenessOriginV1Schema.parse({ kind: 'session' }),
            metadata: { forkV1: { parentSessionId: 'parent', createdAtMs: 200 } },
            sessionTurns: { ...turns, sessionId: 'child', turns: [{ ...turns.turns[0]!, agentId: 'codex' }] } };
        const detail = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({}), sessions: [session, child] });
        expect(detail.collaboration).toEqual([expect.objectContaining({ relation: 'replay', sourceSessionId: 'parent',
            sourceAgentId: 'claude', targetAgentId: 'codex' })]);
        const scoped = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ session: 'child' }), sessions: [session, child] });
        expect(scoped.collaboration?.[0]?.sourceAgentId).toBeNull();
    });
    it('keeps a Run launch distinct from a separate Session explicitly spawned by that Run', () => {
        expect(SessionAwarenessOriginV1Schema.safeParse({ kind: 'execution_run', runId: 'run-review' }).success).toBe(false);
        const child = { ...session, id: 'child', createdAt: 250, origin: SessionAwarenessOriginV1Schema.parse({ kind: 'execution_run' }),
            sessionTurns: { ...turns, sessionId: 'child' } };
        const detail = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({}), sessions: [session, child],
            openedMessages: new Map([['parent', [tool('run-call', 'SubAgentRun', { runId: 'run-review', sidechainId: 'review',
                intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, launchOrigin: { kind: 'session', sessionId: 'parent' } })]]]) });
        expect(detail.collaboration).toHaveLength(2);
        expect(detail.collaboration).toEqual(expect.arrayContaining([
            expect.objectContaining({ relation: 'review', targetId: 'run:run-review' }),
            expect.objectContaining({ relation: 'spawn', targetId: 'session:child', sourceSessionId: null, sourceAgentId: null }),
        ]));
    });
});
