import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from './reducer.js';
import { normalizeRawMessage } from '../raw/normalize.js';

describe('replayed tool metadata', () => {
    it('publishes imported presentation provenance when native tool identity already completed without changing the body', () => {
        const state = createReducer();
        const call = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
            type: 'tool-call', callId: 'visual', name: 'session_board_item_upsert', id: 'call', input: { itemId: 'graph' },
        } } };
        const result = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
            type: 'tool-result', callId: 'visual', id: 'result', output: { stable: 'acknowledged' },
        } } };
        const normalize = (id: string, raw: unknown) => {
            const message = normalizeRawMessage(id, null, 1, raw);
            if (!message) throw new Error('Invalid admitted tool fixture');
            return message;
        };
        reducer(state, [normalize('native-call', call), normalize('native-result', result)], null);
        const forkVisualOriginV1 = { v: 1, serverId: 'home', sessionId: 'parent', sourceMessageId: 'call', sourceSeq: 3 };
        const replayedCall = reducer(state, [normalize('import-call', { ...call, meta: { forkVisualOriginV1 } })], null);
        expect(replayedCall.messages).toHaveLength(1);
        expect(replayedCall.messages[0]).toMatchObject({ meta: { forkVisualOriginV1 }, tool: { state: 'completed', result: { stable: 'acknowledged' } } });
        const resultOrigin = { ...forkVisualOriginV1, sourceMessageId: 'result', sourceSeq: 4 };
        const replayedResult = reducer(state, [normalize('import-result', { ...result, meta: { forkVisualOriginV1: resultOrigin } })], null);
        expect(replayedResult.messages).toHaveLength(1);
        expect(replayedResult.messages[0]).toMatchObject({ meta: { forkVisualOriginV1: resultOrigin }, tool: { state: 'completed', result: { stable: 'acknowledged' } } });
    });
});
