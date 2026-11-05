import { describe, expect, it } from 'vitest';
import * as usage from './usageWorkEvidence.js';
import { UsagePromptCompositionSchema } from './coach/usagePromptComposition.js';
import { selectUsageWorkPermissions } from './usageWorkIntervals.js';
import { projectUsageSessionStateEvidence } from './usageWorkEvidence.js';
import { SessionActionConfirmationsV1Schema } from '../sessions/metadata/sessionActionConfirmationsV1.js';

const empty = { v: 1 as const, minMs: null, maxMs: null };
const tool = (kind: 'tool-call' | 'tool-call-result', payload: unknown) => ({ id: kind, createdAt: 10,
    content: { role: 'agent', content: { type: 'codex', data: kind === 'tool-call'
        ? { type: kind, callId: 'call', name: 'SubAgentRun', input: payload }
        : { type: kind, callId: 'call', output: payload } } } });

describe('Usage non-content timing publication', () => {
    it('keeps unavailable components unknown and distinguishes authored empty snapshots', () => {
        expect(usage.projectUsageSessionTimingV1({})).toEqual({ v: 1, metadata: null, agentState: null });
        expect(usage.projectUsageSessionTimingV1({ metadata: null, agentState: null }))
            .toEqual({ v: 1, metadata: null, agentState: null });
        expect(usage.projectUsageSessionTimingV1({ metadata: {}, agentState: {} }))
            .toEqual({ v: 1, metadata: empty, agentState: empty });
    });

    it('covers current relationship timestamps without disclosing identities or content', () => {
        const timing = usage.projectUsageSessionTimingV1({ metadata: {
            forkV1: { v: 1, parentSessionId: 'private-parent', parentCutoffSeqInclusive: 0, strategy: 'native', createdAtMs: 200 },
            replaySeedV1: { v: 1, seedText: 'private seed', sourceSessionId: 'ignored-replay', sourceCutoffSeqInclusive: 0, createdAtMs: 900 },
            handoffV1: { v: 1, sourceMachineId: 'private-source', targetMachineId: 'private-target', agentId: 'codex', completedAtMs: 500,
                sessionStorageBefore: 'persisted', sessionStorageAfter: 'persisted', transportStrategy: 'server_routed_stream' },
        }, agentState: {} });
        expect(timing).toEqual({ v: 1, metadata: { v: 1, minMs: 200, maxMs: 500 }, agentState: empty });
        expect(usage.projectUsageSessionTimingV1({ metadata: {
            replaySeedV1: { v: 1, seedText: 'private seed', sourceSessionId: 'source', sourceCutoffSeqInclusive: 0, createdAtMs: 900 },
        } }).metadata).toEqual({ v: 1, minMs: 900, maxMs: 900 });
        expect(JSON.stringify(timing)).not.toMatch(/private|codex|ignored/);
    });

    it('covers canceled wait completion and preserves unbounded pending waits', () => {
        const completedRequests = { canceled: { tool: 'private-tool', turnId: 'turn', createdAt: 20,
            completedAt: 80, status: 'canceled' } };
        expect(usage.projectUsageSessionTimingV1({ agentState: { completedRequests } }).agentState)
            .toEqual({ v: 1, minMs: 20, maxMs: 80 });
        expect(usage.projectUsageSessionTimingV1({ agentState: { completedRequests, requests: {
            open: { tool: 'private-tool', turnId: 'turn', createdAt: 50 },
        } } }).agentState).toEqual({ v: 1, minMs: 20, maxMs: null });
    });

    it('keeps genuine shared confirmations in metadata timing without publishing their preview', () => {
        const actionConfirmationsV1 = SessionActionConfirmationsV1Schema.parse({ v: 1, completedRequests: {}, requests: {
            'action:1': { tool: 'Happier Action confirmation', kind: 'user_action', createdAt: 40, turnId: 'turn', source: 'happier_action',
                arguments: { actionId: 'session.activity.get', preview: { text: 'private preview' }, sessionId: 'session', turnId: 'turn' },
                responseTarget: { kind: 'happier_action_confirmation_v1', requestId: 'action:1', actionId: 'session.activity.get',
                    inputDigestV1: `sha256:${'0'.repeat(64)}`, runtimeAccountId: 'account', sessionId: 'session', turnId: 'turn' } },
        } });
        expect(usage.projectUsageSessionTimingV1({ metadata: { actionConfirmationsV1 } }))
            .toEqual({ v: 1, metadata: { v: 1, minMs: 40, maxMs: null }, agentState: null });
    });

    it('distinguishes malformed unknown state from untimed permissions excluded by the canonical period owner', () => {
        expect(usage.projectUsageSessionTimingV1({ agentState: { requests: { bad: { tool: 'Read', createdAt: 'hidden' } } } }).agentState).toBeNull();
        const agentState = { completedRequests: { untimed: { tool: 'Read', status: 'approved' } } };
        const facts = projectUsageSessionStateEvidence({ id: 'session', metadata: null, agentState });
        expect(facts.permissions).toHaveLength(1);
        expect(selectUsageWorkPermissions(facts.permissions, { startMs: 0, endMs: Number.MAX_SAFE_INTEGER }).requests).toEqual([]);
        expect(usage.projectUsageSessionTimingV1({ agentState }).agentState).toEqual(empty);
    });

    it('covers embedded accepted and prompt timestamps independently of message creation', () => {
        const composition = UsagePromptCompositionSchema.parse({ v: 1, evidenceId: 'composition', sessionId: 'session', turnId: null,
            inputId: 'input', observedAtMs: 900, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
            components: [], nativePrefix: null, contextWindowTokens: null });
        expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session', message: {
            id: 'message', localId: 'input', createdAt: 10,
            acceptedDelivery: { v: 1, acceptedAtMs: 700, delivery: { kind: 'newTurn', turnId: 'turn' } },
            content: { role: 'agent', content: { type: 'event', id: 'composition-event', data: { type: 'prompt-composition', composition } } },
        } })).toEqual({ v: 1, minMs: 700, maxMs: 900 });
    });

    it('covers SubAgent timestamps in each separate call and result before pairing', () => {
        for (const kind of ['tool-call', 'tool-call-result'] as const) {
            expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session',
                message: tool(kind, JSON.stringify({ runId: 'private-run', startedAtMs: 900, instructions: 'private prose' })) }))
                .toEqual({ v: 1, minMs: 10, maxMs: 900 });
        }
    });

    it('covers MCP window start and compaction outer time through the real event adapter', () => {
        const event = (data: unknown) => ({ id: 'event', createdAt: 300,
            content: { role: 'agent', content: { type: 'event', id: 'native-event', data } } });
        expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session', message: event({ type: 'mcp-binding-usage', usage: {
            v: 1, evidenceId: 'mcp', sessionId: 'session', turnId: 'turn', observedAtMs: 900,
            window: { startMs: 100, endMs: 900 }, coverage: 'complete', bindings: [],
        } }) })).toEqual({ v: 1, minMs: 100, maxMs: 900 });
        expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session',
            message: event({ type: 'context-compaction', phase: 'completed', source: 'runtime' }) }))
            .toEqual({ v: 1, minMs: 300, maxMs: 300 });
    });

    it('retains untimed relevant witnesses conservatively and ignores ordinary prose', () => {
        expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session', message: {
            ...tool('tool-call', { runId: 'run' }), createdAt: undefined,
        } })).toBeNull();
        expect(usage.projectUsageSessionMessageTimingV1({ sessionId: 'session', message: {
            id: 'text', createdAt: 10, content: { role: 'user', content: { text: 'private prose' } },
        } })).toEqual(empty);
    });

    it('merges delivery settlement bounds without promoting legacy unknown message coverage', () => {
        const point = { v: 1 as const, minMs: 900, maxMs: 900 };
        expect(usage.mergeUsageTimingBoundsV1(null, point)).toBeNull();
        expect(usage.mergeUsageTimingBoundsV1(point, null)).toBeNull();
        expect(usage.mergeUsageTimingBoundsV1(empty, point)).toEqual(point);
        expect(usage.mergeUsageTimingBoundsV1({ v: 1, minMs: 10, maxMs: 20 }, point))
            .toEqual({ v: 1, minMs: 10, maxMs: 900 });
        expect(usage.mergeUsageTimingBoundsV1({ v: 1, minMs: 10, maxMs: null }, point))
            .toEqual({ v: 1, minMs: 10, maxMs: null });
    });

    it('keeps the clear timing envelope closed and rejects unsound bounds', () => {
        for (const value of [
            { v: 1, minMs: null, maxMs: 10 }, { v: 1, minMs: 20, maxMs: 10 },
            { v: 1, minMs: -1, maxMs: 10 }, { v: 1, minMs: 0, maxMs: Number.MAX_SAFE_INTEGER + 1 },
            { v: 1, minMs: 0, maxMs: 10, content: 'private' },
        ]) expect(usage.UsageTimingBoundsV1Schema.safeParse(value).success).toBe(false);
    });
});
