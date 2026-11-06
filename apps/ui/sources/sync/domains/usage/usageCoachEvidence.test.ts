import { describe, expect, it } from 'vitest';
import { UsagePromptCompositionSchema } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';

const composition = UsagePromptCompositionSchema.parse({
    v: 1, evidenceId: 'composition', sessionId: 'session', turnId: 'turn', inputId: 'input',
    observedAtMs: 150, boundary: 'host_pre_dispatch', deliveryKind: 'steer', coverage: 'host_only',
    components: [{ sourceId: 'a'.repeat(64), digest: 'b'.repeat(64), kind: 'instructions', location: 'user',
        byteLength: 200, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' }],
    nativePrefix: null, contextWindowTokens: null,
});
const message = (content: unknown, createdAt = 150) => ({ id: 'message', localId: null, content, createdAt });
const record = (value: unknown) => ({ role: 'agent', content: { type: 'event', id: 'event',
    data: { type: 'prompt-composition', composition: value } } });

describe('opened Session Coach detail', () => {
    it('uses only one accepted new request paired with authoritative completion, preserving its scoped model selection', () => {
        const requestIdentity = { scopeKey: 'a'.repeat(64), digest: 'c'.repeat(64),
            selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'heavy' } };
        const selected = { ...composition, deliveryKind: 'newTurn' as const, requestIdentity };
        const input = { id: 'input-row', localId: 'input', acceptedDelivery: { v: 1 as const, acceptedAtMs: 160,
            delivery: { kind: 'newTurn' as const, turnId: 'turn' } } };
        const session = { id: 'session', metadata: null, agentState: null,
            sessionTurns: { v: 1 as const, sessionId: 'session', updatedAt: 180,
                turns: [{ turnId: 'turn', status: 'completed' as const, startedAt: 160, updatedAt: 180, terminalAt: 180 }] } };
        const read = (messages: Parameters<typeof projectSessionUsageWorkEvidence>[1] = [message(record(selected)), input],
            source: Parameters<typeof projectSessionUsageWorkEvidence>[0] = session) =>
            projectSessionUsageWorkEvidence(source, messages, { messagesComplete: true });
        expect(read()).toHaveProperty('coach.detail.modelRequests', [{ evidenceId: 'composition', observedAtMs: 180,
            sessionId: 'session', turnId: 'turn', startedAtMs: 160, requestIdentity }]);
        expect(read([message(record(selected))])).toHaveProperty('coach.detail.modelRequests', []);
        expect(read(undefined, { ...session, sessionTurns: { ...session.sessionTurns,
            turns: [{ ...session.sessionTurns.turns[0]!, status: 'failed' }] } })).toHaveProperty('coach.detail.modelRequests', []);
        expect(read([message(record(selected)), input, { ...input, id: 'steer', localId: 'second',
            acceptedDelivery: { v: 1 as const, acceptedAtMs: 170, delivery: { kind: 'steer', turnId: 'turn' } } }])).toHaveProperty('coach.detail.modelRequests', []);
        expect(projectSessionUsageWorkEvidence(session, [message(record(selected)), input]))
            .toHaveProperty('coach.detail.modelRequests', []);
        const opened = read();
        const messageEvidence = { acceptedInputs: opened.acceptedInputs, phaseEvents: opened.phaseEvents, coach: opened.coach };
        expect(projectSessionUsageWorkEvidence(session, undefined, { messagesComplete: true, messageEvidence })).toEqual(opened);
        // A fresh Session/turn admission recomputes completion and permission
        // facts from current state without needing the original message body.
        expect(projectSessionUsageWorkEvidence({ ...session, sessionTurns: { ...session.sessionTurns,
            turns: [{ ...session.sessionTurns.turns[0]!, status: 'failed' }] } }, undefined,
        { messagesComplete: true, messageEvidence })).toHaveProperty('coach.detail.modelRequests', []);
    });
    it('projects completed witnessed compactions without counting phases or copying private fields', () => {
        const compaction = (lifecycleId: string, phase: 'started' | 'completed', source = 'runtime') =>
            ({ role: 'agent', content: { type: 'event', id: lifecycleId + phase,
                data: { type: 'context-compaction', lifecycleId, phase, source, turnId: 'turn',
                    sanitizedErrorPreview: 'private agent diagnostics' } } });
        const result = projectSessionUsageWorkEvidence({ id: 'session', metadata: null, agentState: null }, [
            message(compaction('first', 'started'), 110), message(compaction('first', 'completed'), 120),
            message(compaction('first', 'completed'), 120), message(compaction('second', 'completed'), 140),
            message(compaction('inferred', 'completed', 'transcript-inference'), 145),
        ]);
        expect(result).toHaveProperty('coach.detail.compactions', [
            { evidenceId: JSON.stringify(['session', 'first']), observedAtMs: 120, sessionId: 'session', turnId: 'turn' },
            { evidenceId: JSON.stringify(['session', 'second']), observedAtMs: 140, sessionId: 'session', turnId: 'turn' },
        ]);
        expect(JSON.stringify(result)).not.toContain('private agent diagnostics');
    });
    it('projects content-free stored composition for the opened Session while keeping write admission strict', () => {
        const read = (content: unknown) => projectSessionUsageWorkEvidence({ id: 'session', metadata: null, agentState: null }, [message(content)]);
        expect(read(record(composition))).toHaveProperty('coach.composition', [composition]);
        expect(read(record({ ...composition, sessionId: 'another-session' }))).toHaveProperty('coach.composition', []);
        const retained = { ...composition, prompt: 'private prompt', path: '/private/repository' };
        expect(UsagePromptCompositionSchema.safeParse(retained).success).toBe(false);
        const projected = read(record(retained));
        expect(projected).toHaveProperty('coach.composition', [composition]);
        expect(JSON.stringify(projected)).not.toMatch(/private prompt|private\/repository/);
        expect(read(record({ ...composition, components: [{ ...composition.components[0], byteLength: -1 }] })))
            .toHaveProperty('coach.composition', []);
        expect(read({ role: 'agent', content: { type: 'text', text: JSON.stringify(composition) } })).toHaveProperty('coach.composition', []);
    });
});
