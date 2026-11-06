import { describe, expect, it } from 'vitest';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { readUsageSessionMessageProjection } from './messageEvidenceProjection';

const row = {
    id: 'message', localId: null, createdAt: 200, sidechainIds: ['child'], role: 'agent', recordType: 'codex',
    nativeAgentId: 'codex', eventId: null, event: null, acceptedDelivery: null,
    tools: [{ kind: 'call', id: 'call', name: 'SubAgentRun', input: JSON.stringify({
        runId: 'run', sidechainId: 'child', intent: 'review', startedAtMs: 180,
        backendTarget: { kind: 'builtInAgent', agentId: 'codex', privateNested: 'private body' },
        launchOrigin: { kind: 'session', sessionId: 'session', privateNested: 'private body' },
        prompt: 'private body', instructions: 'private body', output: 'private body',
    }) }],
};

describe('Usage stored message witness boundary', () => {
    it('retains both actual native sidechain witnesses rather than the DB lane id', () => {
        const projected = readUsageSessionMessageProjection({ ...row, sidechainId: 'transport-lane',
            sidechainIds: JSON.stringify(['native-sidechain', 'native-parent-tool']) });
        expect(projected?.sidechainIds).toEqual(['native-sidechain', 'native-parent-tool']);
    });

    it('preserves canonical collaboration facts while removing ordinary and nested private payloads', () => {
        const projected = readUsageSessionMessageProjection(row);
        expect(projected).not.toBeNull();
        const session = { id: 'session', metadata: null, agentState: null };
        const raw = [{ id: row.id, createdAt: row.createdAt, content: { role: 'agent', content: {
            type: 'codex', data: { type: 'tool-call', callId: 'call', name: 'SubAgentRun', input: row.tools[0]!.input },
        } } }];
        const expected = projectSessionUsageWorkEvidence(session, raw);
        const actual = projectSessionUsageWorkEvidence(session, undefined, { messageProjections: projected ? [projected] : [] });
        expect(actual).toEqual(expected);
        expect(actual.collaboration).toEqual([expect.objectContaining({ targetId: 'run:run', relation: 'review', observedAtMs: 180 })]);
        expect(JSON.stringify(projected)).not.toContain('private body');
    });

    it('validates stored event and accepted-delivery facts without losing native event identity', () => {
        const projected = readUsageSessionMessageProjection({ ...row, localId: 'input', tools: '[]', sidechainIds: [],
            nativeAgentId: null, recordType: 'event', eventId: 'native-event',
            event: JSON.stringify({ type: 'context-compaction', phase: 'completed', source: 'runtime', privateFuture: 'private body' }),
            acceptedDelivery: JSON.stringify({ v: 1, acceptedAtMs: 150, delivery: { kind: 'newTurn', turnId: 'turn' }, privateFuture: 'private body' }),
        });
        expect(projected?.eventId).toBe('native-event');
        expect(projected?.event?.type).toBe('context-compaction');
        expect(projected?.acceptedDelivery?.delivery.turnId).toBe('turn');
        expect(JSON.stringify(projected)).not.toContain('private body');
        expect(readUsageSessionMessageProjection({ ...row, tools: [{ kind: 'call', id: 5, name: 'Read' }] })).toBeNull();
        expect(readUsageSessionMessageProjection({ ...row, event: { type: 'context-compaction', phase: 'invalid' } })).toBeNull();
        expect(readUsageSessionMessageProjection({ ...row, acceptedDelivery: { v: 1 } })).toBeNull();
    });

    it('keeps invalid nonnull input precedence and does not infer identities from mixed text blocks', () => {
        const toolInput = { runId: 'run', intent: 'private body', startedAtMs: 'private body',
            backendTarget: { wrong: 'private body' }, launchOrigin: { wrong: 'private body' } };
        const result = { runId: 'run', intent: 'review', startedAtMs: 123,
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, launchOrigin: { kind: 'session', sessionId: 'parent' } };
        const projected = readUsageSessionMessageProjection({ ...row, sidechainIds: [], tools: [
            { kind: 'call', id: 'call', name: 'SubAgentRun', input: toolInput },
            { kind: 'result', id: 'call', name: '', result },
            { kind: 'call', id: 'mixed', name: 'SubAgentRun', input: [{ type: 'text', text: JSON.stringify(result) }] },
        ] });
        expect(projected).not.toBeNull();
        const session = { id: 'session', metadata: null, agentState: null };
        const raw = [{ id: 'call', createdAt: 200, content: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: 'call', name: 'SubAgentRun', input: toolInput,
        } } } }, { id: 'result', createdAt: 200, content: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call-result', callId: 'call', output: result,
        } } } }];
        const expected = projectSessionUsageWorkEvidence(session, raw).collaboration;
        const actual = projectSessionUsageWorkEvidence(session, undefined, { messageProjections: projected ? [projected] : [] }).collaboration;
        expect(actual).toEqual(expected);
        expect(actual).toEqual([expect.objectContaining({ relation: 'run', observedAtMs: 200, sourceSessionId: null, targetAgentId: null })]);
        expect(JSON.stringify(projected)).not.toContain('private body');
    });
});
