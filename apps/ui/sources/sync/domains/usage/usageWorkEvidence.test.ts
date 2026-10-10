import { describe, expect, it } from 'vitest';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { projectSessionUsageWorkEvidence } from './usageWorkEvidence';
import { projectUsageQueryWorkEvidence } from './usageWorkEvidence';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveUsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';

describe('opened Session usage work evidence', () => {
    it.each([{ projects: ['project'] }, { sources: ['runtime'] }, { modelIds: ['model'] },
        { workspaceIds: ['workspace'] }, { backendModes: ['agent'] }])('admits exact accounting turns for private evidence scope %j', filters => {
        const scope = { serverId: 'home', accountId: 'account' };
        const session = createSessionFixture({ id: 'session', serverId: 'home', encryptionMode: 'plain', metadata: null,
            sessionTurns: { v: 1, sessionId: 'session', updatedAt: 900, turns: ['selected', 'foreign'].map(turnId => ({
                turnId, agentId: 'codex', status: 'completed' as const, startedAt: 100, terminalAt: 900, updatedAt: 900,
            })) } });
        const contributions = [{ id: 'selected', observedAtMs: 500, sessionId: 'session', turnId: 'selected',
            agentId: 'codex', machineId: null, projectKey: 'project', source: 'runtime', modelId: 'model',
            workspaceId: 'workspace', backendMode: 'agent', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
            cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } }];
        contributions.push({ ...contributions[0]!, id: 'foreign', turnId: 'foreign', projectKey: 'foreign', source: 'foreign',
            modelId: 'foreign', workspaceId: 'foreign', backendMode: 'foreign' });
        const messages = ['selected', 'foreign'].map(turnId => ({ id: turnId, localId: turnId, acceptedDelivery: {
            v: 1 as const, acceptedAtMs: 500, delivery: { kind: 'steer' as const, turnId },
        } }));
        const detail = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery(filters), scope, currentScope: scope,
            isCurrent: true, sessions: [session, { ...session, id: 'foreign-session' }], contributions,
            openedMessages: new Map([['session', messages], ['foreign-session', messages]]) });
        expect(detail).toMatchObject({ status: 'partial', facts: [expect.objectContaining({ workId: '["session","selected"]' })],
            acceptedInputs: [expect.objectContaining({ inputId: 'selected' })] });
        expect(detail.facts).toHaveLength(1);
        expect(detail.acceptedInputs).toHaveLength(1);
        expect(projectUsageQueryWorkEvidence({ query: normalizeUsageQuery(filters), scope, currentScope: scope,
            isCurrent: true, sessions: [session], contributions: contributions.map(row => ({ ...row, turnId: null })),
            openedMessages: new Map([['session', messages]]) })).toEqual({ status: 'unknown' });
    });
    it('opens complete MCP windows from a partial private page without retaining foreign Session evidence', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const session = createSessionFixture({ id: 'session', serverId: 'home', encryptionMode: 'plain' });
        const usage = { v: 1, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn', observedAtMs: 200,
            window: { startMs: 100, endMs: 200 }, coverage: 'complete', bindings: [{ serverId: 'server', bindingId: 'binding',
                serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] };
        const message = { id: 'message', localId: 'retained', content: { role: 'agent', content: {
            type: 'event', id: 'retained-event', data: { type: 'mcp-binding-usage', usage },
        } } };
        const read = (messages: typeof message[]) => projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ session: 'session' }),
            scope, currentScope: scope, isCurrent: true, sessions: [session], openedMessages: new Map([['session', messages]]) });
        expect(read([message, message]).coach?.detail?.mcpUsage).toEqual([usage]);
        expect(read([{ ...message, content: { ...message.content, content: { ...message.content.content,
            data: { type: 'mcp-binding-usage', usage: { ...usage, sessionId: 'foreign' } } } } }]).coach?.detail?.mcpUsage).toEqual([]);
        expect(read([message]).status).toBe('partial');
    });
    it('excludes a denied transcript capability even when private facts were previously opened', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const session = createSessionFixture({ id: 'session', serverId: scope.serverId,
            access: createSessionAccessFixture('view', { readTranscript: false }),
            sessionTurns: { v: 1, sessionId: 'session', updatedAt: 200, turns: [
                { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 200, updatedAt: 200 },
            ] },
            agentState: AgentStateSchema.parse({ completedRequests: { request: {
                tool: 'Bash', arguments: {}, turnId: 'turn', createdAt: 120, completedAt: 150, status: 'approved',
            } } }),
        });
        const detail = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ session: session.id }),
            scope, currentScope: scope, isCurrent: true, sessions: [session],
            openedMessages: new Map([[session.id, [{ id: 'accepted', localId: 'input', acceptedDelivery: {
                v: 1 as const, acceptedAtMs: 160, delivery: { kind: 'steer' as const, turnId: 'turn' },
            } }]]]),
        });
        expect(detail).toEqual({ status: 'unknown' });
        expect(resolveUsageHowYouWork({ detail, period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0 }))
            .toMatchObject({ detailStatus: 'unknown', intervals: null, permissions: null, inputs: null });
    });
    it('keeps absent private facets unknown while an opened empty input page is an observed subset', () => {
        const session = createSessionFixture({ id: 'session', encryptionMode: 'plain', agentState: null, metadata: null,
            sessionTurns: { v: 1, sessionId: 'session', updatedAt: 200, turns: [
                { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 200, updatedAt: 200 },
            ] } });
        const compose = (detail: ReturnType<typeof projectSessionUsageWorkEvidence>) => resolveUsageHowYouWork({
            period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0, detail,
        });
        expect(compose(projectSessionUsageWorkEvidence(session))).toMatchObject({
            detailStatus: 'partial', intervals: { agentTimeMs: 100 }, permissions: null, inputs: null,
        });
        expect(compose(projectSessionUsageWorkEvidence(session, []))).toMatchObject({
            permissions: null, inputs: { acceptedCount: 0, steeringCount: 0 },
        });
    });
    it('keeps missing historical acceptance and permission capture unknown without discarding observed empty maps', () => {
        const session = createSessionFixture({ id: 'session', encryptionMode: 'plain', metadata: null,
            agentState: AgentStateSchema.parse({ controlledByUser: true }) });
        const compose = (detail: ReturnType<typeof projectSessionUsageWorkEvidence>) => resolveUsageHowYouWork({
            period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0, detail,
        });
        for (const page of [
            [{ id: 'legacy-user', localId: 'legacy', content: { role: 'user', content: { type: 'text', text: 'legacy prompt' } } }],
            [{ id: 'manual-handled', localId: 'manual' }],
            [{ id: 'unidentified', localId: null, acceptedDelivery: { v: 1 as const, acceptedAtMs: 600,
                delivery: { kind: 'newTurn' as const, turnId: 'turn' } } }],
        ]) {
            expect(compose(projectSessionUsageWorkEvidence(session, page))).toMatchObject({
                permissions: null, inputs: null,
            });
        }
        expect(compose(projectSessionUsageWorkEvidence({ ...session,
            agentState: AgentStateSchema.parse({ requests: {}, completedRequests: {} }),
        }, []))).toMatchObject({ permissions: { requestCount: 0, pairedDecisionCount: 0 }, inputs: { acceptedCount: 0, steeringCount: 0 } });
        expect(compose(projectSessionUsageWorkEvidence({ ...session, agentState: null,
            metadata: { path: '', host: '', actionConfirmationsV1: { v: 1, requests: {}, completedRequests: {} } },
        }))).toMatchObject({ permissions: { requestCount: 0, pairedDecisionCount: 0 }, inputs: null });
    });
    it('admits only the current equal-Account opened subset and applies witnessed filters without broadening unknown dimensions', () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const session = createSessionFixture({ id: 'session-a', serverId: 'home-a', encryptionMode: 'plain',
            metadata: { path: '', host: '', machineId: 'machine-a' },
            sessionTurns: { v: 1, sessionId: 'session-a', updatedAt: 200, turns: [
                { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 200, updatedAt: 200 },
            ] } });
        const query = normalizeUsageQuery({ agents: ['codex'], machines: ['machine-a'] });
        const read = (overrides: Partial<Parameters<typeof projectUsageQueryWorkEvidence>[0]> = {}) => projectUsageQueryWorkEvidence({
            query, scope, currentScope: scope, isCurrent: true,
            // Same Session id across Homes/availability states defeats accidental id-only admission.
            sessions: [session, { ...session, serverId: 'home-b' },
                { ...session, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' }],
            ...overrides,
        });
        expect(read()).toMatchObject({ status: 'partial', facts: [expect.objectContaining({ workId: '["session-a","turn"]' })] });
        expect(read({ currentScope: { ...scope, accountId: 'other-account' } })).toEqual({ status: 'unknown' });
        expect(read({ isCurrent: false })).toEqual({ status: 'unknown' });
        expect(read({ query: normalizeUsageQuery({ machines: ['different'] }) })).toMatchObject({ status: 'partial', facts: [] });
        expect(read({ query: normalizeUsageQuery({ modelIds: ['unproven-model'] }) })).toEqual({ status: 'unknown' });
    });
    it('counts only retained admitted input outcomes, never requested steering intent', () => {
        const result = projectSessionUsageWorkEvidence({ id: 'session', metadata: null, agentState: null }, [
            { id: 'accepted', localId: 'input', acceptedDelivery: { v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' } } },
            { id: 'queued-intent', localId: 'queued' },
            { id: 'unidentified', localId: null, acceptedDelivery: { v: 1, acceptedAtMs: 600, delivery: { kind: 'newTurn', turnId: 'other' } } },
        ]);
        expect(result.acceptedInputs).toEqual([
            { inputId: 'input', workId: '["session","turn"]', acceptedAtMs: 500, deliveryKind: 'steer', turnId: 'turn' },
        ]);
    });
    it('pairs exact request identities with their witnessed turn, without filling unknown times or historical devices', () => {
        const result = projectSessionUsageWorkEvidence({
            id: 'session', metadata: null,
            sessionTurns: { v: 1, sessionId: 'session', updatedAt: 900, turns: [
                { turnId: 'closed', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
                { turnId: 'open', agentId: 'codex', status: 'in_progress', startedAt: 1000, updatedAt: 1300 },
            ] },
            agentState: AgentStateSchema.parse({ requests: {
                unanswered: { tool: 'Read', arguments: {}, turnId: 'open', createdAt: 1100 },
            }, completedRequests: {
                answered: { tool: 'Bash', arguments: {}, turnId: 'closed', createdAt: 300, completedAt: 500, status: 'approved', answeringClientCategory: 'ios' },
                historical: { tool: 'Read', arguments: {}, createdAt: 200, completedAt: 250, status: 'approved' },
            } }),
        });
        expect(result.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ workId: '["session","closed"]', kind: 'busy', startMs: 100, endMs: 900 }),
            expect.objectContaining({ workId: '["session","open"]', kind: 'busy', startMs: 1000, endMs: null }),
            expect.objectContaining({ evidenceId: 'answered', workId: '["session","closed"]', kind: 'permission_wait', startMs: 300, endMs: 500 }),
            expect.objectContaining({ evidenceId: 'unanswered', kind: 'permission_wait', startMs: 1100, endMs: null }),
        ]));
        expect(result.permissions).toEqual(expect.arrayContaining([
            { requestId: 'answered', workId: '["session","closed"]', requestedAtMs: 300, decidedAtMs: 500, toolId: 'Bash', answeringClientCategory: 'ios' },
            { requestId: 'unanswered', workId: '["session","open"]', requestedAtMs: 1100, decidedAtMs: null, toolId: 'Read', answeringClientCategory: null },
            { requestId: 'historical', workId: '["session",null]', requestedAtMs: 200, decidedAtMs: 250, toolId: 'Read', answeringClientCategory: null },
        ]));
        expect(result.facts?.some(fact => fact.evidenceId === 'historical')).toBe(false);
        expect(result.status).toBe('partial');
    });
});
