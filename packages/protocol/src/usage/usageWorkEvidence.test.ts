import { describe, expect, it } from 'vitest';
import { projectSessionUsageWorkEvidence, projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds,
    usageQueryNeedsSessionCandidates, type UsageSessionMessageProjection } from './usageWorkEvidence.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsageCollaboration } from './usageCollaboration.js';
import { SessionAwarenessOriginV1Schema } from '../sessions/awareness/projectionV1.js';
import { UsageAnalyticsContributionSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { UsagePromptCompositionSchema } from './coach/usagePromptComposition.js';
import { TranscriptRawAgentEventV1Schema } from '../sessions/messages/transcriptRawRecordV1.js';
import * as workEvidence from './usageWorkEvidence.js';
import { SessionSystemRecordPayloadSchema } from '../sessions/system/records/sessionSystemRecordPayloads.js';

const turns = { v: 1 as const, sessionId: 'parent', updatedAt: 900, turns: [
    { turnId: 'old', agentId: 'claude', status: 'completed' as const, startedAt: 100, terminalAt: 500, updatedAt: 500 },
    { turnId: 'new', agentId: 'codex', status: 'in_progress' as const, startedAt: 600, updatedAt: 900 },
] };
const session = { id: 'parent', metadata: { machineId: 'machine' }, agentState: null, sessionTurns: turns };
it('keeps shared compactions in work facts without Coach-only composition or model evidence', () => {
    const compactions = [{ evidenceId: 'compacted', observedAtMs: 300, sessionId: session.id, turnId: 'old' }];
    const evidence = { status: 'available' as const, coach: { compositionCoverage: 'complete' as const,
        composition: [], detail: { coverage: 'complete' as const, compactions, modelRequests: [], mcpUsage: [] } } };
    const fact = workEvidence.createUsageSessionWorkFactsV1({ ...session, seq: 2, active: false }, evidence);
    expect(fact.evidence.coach?.detail?.compactions).toEqual(compactions);
    expect(fact.evidence.coach).not.toHaveProperty('composition');
    expect(fact.evidence.coach).not.toHaveProperty('compositionCoverage');
    expect(fact.evidence.coach?.detail).not.toHaveProperty('modelRequests');
    expect(fact.evidence.coach?.detail).not.toHaveProperty('mcpUsage');
    const records = workEvidence.createUsageSessionFactRecordsV1({ ...session, seq: 2, active: false }, evidence);
    expect(records.map(record => workEvidence.UsageSessionFactRecordV1Schema.parse(record))).toEqual(records);
    expect(records.map(record => SessionSystemRecordPayloadSchema.safeParse(record).success)).toEqual([true, true]);
    expect(records.find(record => record.kind === 'coach')?.evidence).toEqual(evidence.coach);
});
const tool = (id: string, name: string, input: unknown, createdAt = 200) => ({ id, createdAt,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: id, name, input } } } });
const contribution = (sessionId: string, turnId: string) => UsageAnalyticsContributionSchema.parse({
    id: JSON.stringify([sessionId, turnId]), observedAtMs: 300, sessionId, turnId,
    agentId: 'claude', modelId: null, machineId: 'machine', projectKey: null, workspaceId: null, source: 'runtime',
    tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 14 },
    cost: { reportedUsd: 1, estimatedUsd: 2, invoiceUsd: 3, currency: 'USD' },
});

it('unions compact accounting subjects with current Machine discovery candidates', () => {
    const query = normalizeUsageQuery({ machines: ['historical-machine'] });
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [{ id: 'current' }, { id: 'shared' }],
        admittedTurns: [{ sessionId: 'historical', turnId: 'turn' }, { sessionId: 'shared', turnId: 'turn' }],
    })).toEqual(['current', 'shared', 'historical']);
});

it.each(['coach', 'overview', 'work', 'action'] as const)(
    'excludes failed empty archived Sessions while retaining real archived usage for %s', surface => {
        const sessions = ['failed-empty', 'real-archived'].map(id => ({ id, archived: true, seq: 0,
            sessionTurns: { v: 1 as const, sessionId: id, updatedAt: 300, turns: [] } }));
        const contributions = [contribution('real-archived', 'completed-turn')];
        const query = normalizeUsageQuery({ includeCoach: surface === 'coach', includeWorkEvidence: surface === 'work' });
        for (const evidence of [
            { contributions },
            { sessionMembership: { sessionIds: ['real-archived'], turns: [] } },
        ]) {
            expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions, ...evidence })).toEqual(['real-archived']);
            expect(selectUsageQueryWorkEvidenceSessionIds({ query: normalizeUsageQuery({ ...query, session: 'failed-empty' }),
                sessions, ...evidence })).toEqual([]);
        }
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions, contributions: [] })).toEqual([]);
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [...sessions, { ...session, seq: 0 }], contributions: [] }))
            .toEqual(['parent']);
    });

it('retains compact null-turn Session membership without inventing admitted turns', () => {
    const query = normalizeUsageQuery({ projects: ['historical-project'] });
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: { input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
        sessionIds: ['legacy-a', 'legacy-b', 'legacy-c'], sessionMembership: { turns: [] },
    });
    const wire = JSON.stringify(accounting);
    const sessionMembership = workEvidence.readUsageAccountingSessionMembership(accounting);
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [], sessionMembership }))
        .toEqual(['legacy-a', 'legacy-b', 'legacy-c']);
    expect(sessionMembership?.turns).toEqual([]);
    expect(JSON.stringify(accounting)).toBe(wire);
    expect(accounting.sessionMembership).toEqual({ turns: [] });
    expect(selectUsageQueryWorkEvidenceSessionIds({ query: normalizeUsageQuery({ ...query, session: 'legacy-b' }),
        sessions: [], sessionMembership })).toEqual(['legacy-b']);
    expect(projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ population: 'public_eligible_personal' }),
        sessions: [{ ...session, id: 'legacy-a' }], sessionMembership })).toEqual({ status: 'unknown' });
});

it('uses current compact lifecycle facts for eligibility when the original turn list is absent', () => {
    const empty = { id: 'failed-empty', seq: 0, active: false, metadata: null, agentState: null,
        sessionTurns: { v: 1 as const, sessionId: 'failed-empty', updatedAt: 300, turns: [] } };
    const usageWorkFactsV1 = workEvidence.createUsageSessionWorkFactsV1(empty,
        projectSessionUsageWorkEvidence(empty, [], { messagesComplete: true }));
    const compact = { ...empty, sessionTurns: undefined, usageWorkFactsV1 };
    const query = normalizeUsageQuery({ includeCoach: true });
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [compact] })).toEqual([]);
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [compact], selectedSessionIds: [compact.id] })).toEqual([]);
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [compact],
        sessionMembership: { sessionIds: [compact.id], turns: [] } })).toEqual([compact.id]);
    expect(selectUsageQueryWorkEvidenceSessionIds({ query,
        sessions: [{ ...compact, usageWorkFactsV1: { ...usageWorkFactsV1, seq: 1 } }] })).toEqual([compact.id]);
});

it('retains matching legacy null-turn contributions in scoped Session demand', () => {
    const query = normalizeUsageQuery({ projects: ['historical-project'] });
    const contributions = [{ ...contribution('legacy', 'unused'), turnId: null, projectKey: 'historical-project' }];
    expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [], contributions })).toEqual(['legacy']);
});

it('invalidates retained membership when a null-turn Session leaves the admitted population', () => {
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query: normalizeUsageQuery({}),
        admittedTurns: [], previousAdmittedTurns: [],
        sessionMembership: { turns: [], sessionIds: ['legacy-a'] },
        previousSessionMembership: { turns: [], sessionIds: ['legacy-a', 'legacy-b'] },
    })).toBe(false);
});

it('reuses identical admitted membership without visiting facts while changed turns and unknown inputs still invalidate it', () => {
    const query = normalizeUsageQuery({ modelIds: ['model'] });
    let visits = 0;
    const sample = { ...contribution('session', 'turn'), modelId: 'model' };
    // Existing Account capture contains 5,288 contributions and 664 admitted turns.
    const contributions = Array.from({ length: 5288 }, (_, index) => ({ ...sample, id: `row-${index}`,
        get sessionId() { visits += 1; return 'session'; },
    }));
    const admittedTurns = Array.from({ length: 664 }, (_, index) => ({ sessionId: 'session', turnId: `turn-${index}` }));
    const sessionMembership = { turns: admittedTurns, sessionIds: ['session'] };
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query, contributions, previousContributions: contributions,
        admittedTurns, previousAdmittedTurns: admittedTurns, sessionMembership, previousSessionMembership: sessionMembership })).toBe(true);
    expect(visits, 'identical admitted membership must not reconstruct either population').toBe(0);
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query })).toBe(false);
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query, contributions: [], previousContributions: [] })).toBe(true);
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query, contributions, previousContributions: contributions,
        admittedTurns: [{ sessionId: 'session', turnId: 'replacement' }], previousAdmittedTurns: admittedTurns })).toBe(false);
    expect(workEvidence.hasSameUsageQueryWorkEvidenceMembership({ query, contributions, previousContributions: contributions,
        sessionMembership: { turns: admittedTurns, sessionIds: ['session', 'new-null-turn-session'] },
        previousSessionMembership: sessionMembership })).toBe(false);
});

describe('Usage shared work evidence', () => {
    it('round-trips the compact private context through the same registered fact schema', () => {
        const opened = { ...session, seq: 7, metadataVersion: 3, agentStateVersion: 2,
            metadata: { ...session.metadata, privateBody: 'unconsumed private body',
                forkV1: { parentSessionId: 'source', createdAtMs: 110 },
                replaySeedV1: { sourceSessionId: 'source', createdAtMs: 120 },
                handoffV1: { sourceMachineId: 'from', targetMachineId: 'to', agentId: 'codex', completedAtMs: 130 } },
            ownerMetadata: { machineId: 'machine', path: '/repo' }, agentTarget: null };
        const facts = workEvidence.createUsageSessionWorkFactsV1(opened, projectSessionUsageWorkEvidence(opened, []));
        expect(workEvidence.UsageSessionWorkFactsV1Schema.parse(facts)).toEqual(facts);
        expect(facts.session?.ownerMetadata).toEqual(opened.ownerMetadata);
        expect(JSON.stringify(facts)).not.toContain('unconsumed private body');
        expect(workEvidence.UsageSessionWorkFactsV1Schema.safeParse({ ...facts, session: {
            ...facts.session, metadata: { ...facts.session?.metadata, privateBody: 'unconsumed private body' },
        } }).success).toBe(false);
    });
    it('reuses encrypted Session transcript facts without reading the transcript, and withdraws stale facts', () => {
        const opened = { ...session, seq: 7, metadataVersion: 3, agentStateVersion: 2 };
        const messages = [tool('read', 'Read', { file_path: '/private/file' }, 300)];
        const original = projectSessionUsageWorkEvidence(opened, messages, { messagesComplete: true });
        const usageWorkFactsV1 = { v: 1 as const, kind: 'work' as const, seq: 7, metadataVersion: 3, agentStateVersion: 2, evidence: original };
        const converted = { ...opened, usageWorkFactsV1 };
        const restored = projectSessionUsageWorkEvidence(workEvidence.projectUsageSessionInput(converted));
        expect(restored.phaseEvents).toEqual(original.phaseEvents);
        expect(restored.acceptedInputs).toEqual(original.acceptedInputs);
        expect(restored.facts).toEqual(original.facts);
        expect(restored.permissions).toEqual(original.permissions);
        expect(restored.coach).toEqual(original.coach);
        expect(restored).toEqual(original);
        expect(projectSessionUsageWorkEvidence(converted, []).phaseEvents).toEqual([]);
        const persisted = workEvidence.createUsageSessionWorkFactsV1(opened, original);
        expect(workEvidence.UsageSessionWorkFactsV1Schema.parse(persisted)).toEqual(persisted);
        const coach = workEvidence.createUsageSessionFactRecordsV1(opened, original).find(record => record.kind === 'coach');
        expect({ ...persisted.evidence, coach: coach?.evidence }).toEqual(original);
        expect(workEvidence.readCurrentUsageSessionWorkFactsV1(converted)).toBe(usageWorkFactsV1);
        expect(JSON.stringify(usageWorkFactsV1)).not.toContain('/private/file');
        expect(projectSessionUsageWorkEvidence({ ...converted, seq: 8 }).phaseEvents).toBeUndefined();
        expect(projectSessionUsageWorkEvidence({ ...converted, metadataVersion: 4 }).phaseEvents).toBeUndefined();
        expect(projectSessionUsageWorkEvidence({ ...converted, agentStateVersion: 3 }).phaseEvents).toBeUndefined();
        expect(workEvidence.readCurrentUsageSessionWorkFactsV1({ ...converted, seq: undefined })).toBeNull();
        expect(workEvidence.readCurrentUsageSessionWorkFactsV1({ ...converted, active: true })).toBeNull();
    });
    it('retains only consumed Session facts without scaling with private document bodies', () => {
        const makeSession = (body: string) => ({ ...session, createdAt: 90,
            origin: SessionAwarenessOriginV1Schema.parse({ kind: 'execution_run' }),
            manager: { sessionId: 'manager', privateBody: body },
            metadata: { machineId: 'machine', privateBody: body,
                forkV1: { parentSessionId: 'source', createdAtMs: 110, privateBody: body },
                replaySeedV1: { sourceSessionId: 'replay', createdAtMs: 120, privateBody: body },
                handoffV1: { sourceMachineId: 'from', targetMachineId: 'to', agentId: 'codex', completedAtMs: 130, privateBody: body },
            },
            agentState: { privateBody: body, completedRequests: {
                decided: { tool: 'Write', turnId: 'old', createdAt: 150, completedAt: 250,
                    status: 'approved', answeringClientCategory: 'web', arguments: { body } },
            } },
        });
        const small = makeSession('');
        const large = makeSession('unconsumed private document '.repeat(20_000));
        const retained = workEvidence.projectUsageSessionInput(large);
        expect(projectSessionUsageWorkEvidence(retained)).toEqual(projectSessionUsageWorkEvidence(large));
        expect(projectSessionUsageWorkEvidence(retained, [tool('call', 'Read', {}, 300)]))
            .toEqual(projectSessionUsageWorkEvidence(large, [tool('call', 'Read', {}, 300)]));
        expect(JSON.stringify(retained).length).toBe(JSON.stringify(workEvidence.projectUsageSessionInput(small)).length);
        expect(retained.agentState).toBeNull();
        expect(retained.stateEvidence?.permissions).toHaveLength(1);
        expect(retained.origin).toEqual(large.origin);
        expect(retained.manager).toEqual({ sessionId: 'manager' });
    });

    it('preserves unknown, known-empty and already-projected Session state coverage', () => {
        const unknown = { id: 'unknown', metadata: null, agentState: null };
        const empty = { ...unknown, agentState: { requests: {} } };
        const confirmations = { ...unknown, metadata: { actionConfirmationsV1: { v: 1, requests: {}, completedRequests: {} } } };
        const projected = { ...unknown, stateEvidence: { permissions: [], waits: [] } };
        for (const input of [unknown, empty, confirmations, projected]) {
            const retained = workEvidence.projectUsageSessionInput(input);
            expect(projectSessionUsageWorkEvidence(retained)).toEqual(projectSessionUsageWorkEvidence(input));
        }
        expect(workEvidence.projectUsageSessionInput(unknown).stateEvidence).toBeUndefined();
        expect(workEvidence.projectUsageSessionInput(empty).stateEvidence).toEqual({ permissions: [], waits: [] });
        expect(workEvidence.projectUsageSessionInput(confirmations).stateEvidence).toEqual({ permissions: [], waits: [] });
        expect(workEvidence.projectUsageSessionInput(projected).stateEvidence).toBe(projected.stateEvidence);
    });

    it('retains old open permission and user waits without a supplied SessionTurn', () => {
        const detail = projectSessionUsageWorkEvidence({ id: 'legacy', metadata: null,
            agentState: { requests: {
                permission: { tool: 'Read', turnId: 'missing-turn', createdAt: 100 },
                user: { tool: 'Confirm', kind: 'user_action', turnId: 'missing-turn', createdAt: 200 },
            } } });
        expect(detail.facts).toEqual([
            { workId: JSON.stringify(['legacy', 'missing-turn']), evidenceId: 'permission', agentId: null,
                machineId: null, kind: 'permission_wait', startMs: 100, endMs: null },
            { workId: JSON.stringify(['legacy', 'missing-turn']), evidenceId: 'user', agentId: null,
                machineId: null, kind: 'user_wait', startMs: 200, endMs: null },
        ]);
    });

    it('retains permission decisions and waits from compact state without private arguments', () => {
        const full = { ...session, agentState: { requests: {
            open: { tool: 'Read', turnId: 'new', createdAt: 650 },
        }, completedRequests: {
            decided: { tool: 'Write', turnId: 'old', createdAt: 150, completedAt: 250, status: 'approved', answeringClientCategory: 'web' },
            canceled: { tool: 'Confirm', kind: 'user_action', turnId: 'old', createdAt: 160, completedAt: 260, status: 'canceled' },
            unknown: { tool: '', status: 'approved' },
        } } };
        const expected = projectSessionUsageWorkEvidence(full);
        const stateEvidence = { permissions: expected.permissions ?? [], waits: (expected.facts ?? []).filter(fact => fact.kind !== 'busy') };
        expect(projectSessionUsageWorkEvidence({ ...session, stateEvidence })).toEqual(expected);
        expect(workEvidence.projectUsageSessionStateEvidence(full)).toEqual(stateEvidence);
        expect(stateEvidence.permissions).toHaveLength(4);
        expect(stateEvidence.waits).toHaveLength(3);
        expect(stateEvidence.permissions.find(fact => fact.requestId === 'canceled')?.decidedAtMs).toBeNull();
        expect(stateEvidence.waits.find(fact => fact.evidenceId === 'canceled')?.endMs).toBe(260);
        expect(projectSessionUsageWorkEvidence({ ...full, stateEvidence: { permissions: [], waits: [] } }).permissions).toEqual([]);
    });

    it('attributes compact state waits to the opened owner machine while opaque server context stays unknown', () => {
        const full = { ...session, agentState: { completedRequests: {
            permission: { tool: 'Write', turnId: 'old', createdAt: 150, completedAt: 250, status: 'approved' },
            confirmation: { tool: 'Confirm', kind: 'user_action', turnId: 'new', createdAt: 650, completedAt: 750, status: 'approved' },
        } } };
        const serverSession = { ...full, metadata: null };
        const stateEvidence = workEvidence.projectUsageSessionStateEvidence(serverSession);
        expect(stateEvidence.waits.map(fact => fact.machineId)).toEqual([null, null]);
        const expected = projectSessionUsageWorkEvidence(full);
        expect(projectSessionUsageWorkEvidence({ ...session, stateEvidence })).toEqual(expected);
        expect(projectSessionUsageWorkEvidence({ ...session, stateEvidence: {
            ...stateEvidence, waits: stateEvidence.waits.map(fact => ({ ...fact, machineId: 'older-owner-machine' })),
        } })).toEqual(expected);
        expect(projectSessionUsageWorkEvidence({ ...serverSession, agentState: null, stateEvidence }))
            .toEqual(projectSessionUsageWorkEvidence(serverSession));
    });

    it('folds projected message witnesses into the same private facts without transporting prose or ordinary tool output', () => {
        const composition = UsagePromptCompositionSchema.parse({ v: 1, evidenceId: 'composition', sessionId: 'parent', turnId: 'old', inputId: 'accepted',
            observedAtMs: 150, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only', components: [],
            nativePrefix: null, contextWindowTokens: null, requestIdentity: { scopeKey: 'a'.repeat(64), digest: 'b'.repeat(64),
                selection: { agentTargetKey: 'agent:happier.agent.codex:codex', providerConnectionId: null, modelId: 'model' } } });
        const compaction = TranscriptRawAgentEventV1Schema.parse({ type: 'context-compaction', phase: 'completed', source: 'runtime' });
        const run = { runId: 'projected-run', sidechainId: 'projected-sidechain', intent: 'review', startedAtMs: 200,
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, launchOrigin: { kind: 'session', sessionId: 'parent' } };
        const acceptedDelivery = { v: 1 as const, acceptedAtMs: 140, delivery: { kind: 'newTurn' as const, turnId: 'old' } };
        const raw = [tool('call', 'SubAgentRun', { instructions: 'private instructions' }),
            { id: 'result', createdAt: 210, content: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call-result', callId: 'call', output: JSON.stringify({ ...run, output: 'private tool output' }) } } } },
            { id: 'input', localId: 'accepted', createdAt: 140, acceptedDelivery, content: { role: 'user', content: { text: 'private user text' } } },
            { id: 'composition-message', createdAt: 150, content: { role: 'agent', content: { type: 'event', id: 'composition-event', data: { type: 'prompt-composition', composition } } } },
            { id: 'compaction-message', localId: 'different-local-id', createdAt: 300,
                content: { role: 'agent', content: { type: 'event', id: 'native-compaction-event', data: compaction } } },
            tool('read', 'Read', { file_path: '/private/path' }, 220), tool('unnamed', '', {}, 230)];
        const messageProjections: UsageSessionMessageProjection[] = [
            { id: 'call', createdAt: 200, nativeAgentId: 'codex', sidechainIds: [], tools: [{ kind: 'call', id: 'call', name: 'SubAgentRun' }] },
            { id: 'result', createdAt: 210, nativeAgentId: 'codex', sidechainIds: [], tools: [{ kind: 'result', id: 'call', name: '', result: run }] },
            { id: 'input', localId: 'accepted', createdAt: 140, acceptedDelivery, nativeAgentId: null, sidechainIds: [], tools: [] },
            { id: 'composition-message', createdAt: 150, nativeAgentId: null, sidechainIds: [], tools: [], event: TranscriptRawAgentEventV1Schema.parse({ type: 'prompt-composition', composition }) },
            { id: 'compaction-message', localId: 'different-local-id', createdAt: 300, nativeAgentId: null, sidechainIds: [], tools: [], eventId: 'native-compaction-event', event: compaction },
            { id: 'read', createdAt: 220, nativeAgentId: 'codex', sidechainIds: [], tools: [{ kind: 'call', id: 'read', name: 'Read' }] },
            { id: 'unnamed', createdAt: 230, nativeAgentId: 'codex', sidechainIds: [], tools: [{ kind: 'call', id: 'unnamed', name: '' }] },
        ];
        const expected = projectSessionUsageWorkEvidence(session, raw, { messagesComplete: true });
        const projected = projectSessionUsageWorkEvidence(session, undefined, { messageProjections, messagesComplete: true });
        expect(projected).toEqual(expected);
        expect(projected.collaboration).toEqual([expect.objectContaining({ relation: 'review', targetId: 'run:projected-run', observedAtMs: 200 })]);
        expect(projected.coach?.detail?.compactions).toEqual([{ evidenceId: '["parent","native-compaction-event"]', observedAtMs: 300, sessionId: 'parent', turnId: null }]);
        expect(projected.coach?.detail?.modelRequests).toHaveLength(1);
        expect(projected.phaseEvents?.map(row => row.evidenceId)).toEqual(['call', 'read', 'unnamed']);
        expect(projectSessionUsageWorkEvidence(session, undefined, { messageProjections, messagesComplete: false }).coach?.detail?.modelRequests).toEqual([]);
        expect(JSON.stringify(projected)).not.toMatch(/private instructions|private tool output|private user text|private\/path/);
        const retained = projectSessionUsageWorkEvidence(session, undefined, { messagesComplete: true, messageEvidence: projected });
        expect(retained).toEqual(projected);
    });

    it('adapts only valid raw native records and keeps sidechain witnesses while dropping prose', () => {
        const child = { id: 'child', createdAt: 210, content: { role: 'agent', content: { type: 'output', data: {
            type: 'assistant', parent_tool_use_id: 'task', message: { role: 'assistant', content: [{ type: 'text', text: 'private child prose' }] },
        } } } };
        expect(workEvidence.projectUsageSessionMessageProjection(child)).toMatchObject({ nativeAgentId: 'claude', sidechainIds: ['task'], tools: [] });
        expect(JSON.stringify(workEvidence.projectUsageSessionMessageProjection(child))).not.toContain('private child prose');
        const malformed = { id: 'bad', createdAt: 210, content: { role: 'agent', content: { type: 'acp', agentId: 'codex',
            data: { type: 'tool-call', callId: 'call', name: 'Read', input: {} } } } };
        expect(workEvidence.projectUsageSessionMessageProjection(malformed)).toMatchObject({ nativeAgentId: null, sidechainIds: [], tools: [] });
        expect(projectSessionUsageWorkEvidence(session, undefined, { messageProjections: [] })).toEqual(projectSessionUsageWorkEvidence(session, []));
    });
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
    it.each(['contributions', 'admitted-turns'] as const)('intersects public detail with exact admitted turns rather than the whole mixed Session (%s)', inputKind => {
        const query = normalizeUsageQuery({ population: 'public_eligible_personal' });
        const contributions = [contribution('parent', 'old')];
        const accountingMembership = inputKind === 'contributions' ? { contributions } : {
            admittedTurns: [{ sessionId: 'parent', turnId: 'old' }],
        };
        const mixed = { ...session, agentState: { completedRequests: {
            eligible: { tool: 'Read', turnId: 'old', createdAt: 200, completedAt: 250, status: 'approved' },
            excluded: { tool: 'Read', turnId: 'new', createdAt: 700, completedAt: 750, status: 'approved' },
        } } };
        const openedMessages = new Map([['parent', [tool('eligible-child', 'SubAgent', { sidechainId: 'eligible' }, 200),
            tool('excluded-child', 'SubAgent', { sidechainId: 'excluded' }, 700)]]]);
        expect(selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [mixed, { id: 'unrelated' }], ...accountingMembership })).toEqual(['parent']);
        const detail = projectUsageQueryWorkEvidence({ query, sessions: [mixed], openedMessages, ...accountingMembership });
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

    it('updates a retained target historical attribution when its actual source Session changes or leaves admission', () => {
        const child = { ...session, id: 'child', metadata: { forkV1: { parentSessionId: 'parent', createdAtMs: 200 } },
            sessionTurns: { ...turns, sessionId: 'child', turns: [{ ...turns.turns[0]!, agentId: 'codex' }] } };
        const childEvidence = projectSessionUsageWorkEvidence(child);
        const query = normalizeUsageQuery({});
        const run = (source: typeof session | undefined) => projectUsageQueryWorkEvidence({ query,
            sessions: source ? [source, child] : [child],
            sessionEvidence: new Map([['child', childEvidence], ...(source ? [[source.id, projectSessionUsageWorkEvidence(source)] as const] : [])]),
        }).collaboration?.[0]?.sourceAgentId;
        expect(run(session)).toBe('claude');
        const changed = { ...session, sessionTurns: { ...turns, turns: turns.turns.map(turn => ({ ...turn, agentId: 'gemini' })) } };
        expect(run(changed)).toBe('gemini');
        expect(run(undefined)).toBeNull();
        expect(run(session)).toBe('claude');
        expect(childEvidence.collaboration?.[0]?.sourceAgentId).toBeNull();
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
