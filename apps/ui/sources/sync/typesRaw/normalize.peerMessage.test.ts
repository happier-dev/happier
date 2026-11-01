import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { createReducer, reducer } from '../reducer/reducer';

// CLI projection of a Claude native subagent hand-back that has no linked launching tool.
const peerOutput = {
    role: 'agent',
    content: { type: 'output', data: { type: 'user', uuid: 'peer',
        origin: { kind: 'peer', from: 'a1', senderTaskId: 'a1', name: 'general-purpose', handback: true },
        message: { role: 'user', content: 'From general-purpose:\n\n**Verdict:** fixed.' } } },
    meta: { source: 'cli' },
};

describe('typesRaw.normalizeRawMessage (peer messages)', () => {
    it('keeps a nested peer delivery as attributed agent text within its sidechain', () => {
        const nestedPeerOutput = {
            ...peerOutput,
            content: { ...peerOutput.content, data: { ...peerOutput.content.data, isSidechain: true, sidechainId: 'parent-tool' } },
        };
        const normalized = normalizeRawMessage('nested-peer', null, 1, nestedPeerOutput as never, { messageRole: 'agent' });
        const state = createReducer();
        reducer(state, normalized ? [normalized] : []);
        expect(state.sidechains.get('parent-tool')).toEqual([
            expect.objectContaining({ role: 'agent', text: '**Verdict:** fixed.',
                peer: { name: 'general-purpose', handback: true } }),
        ]);
    });

    // Released CLIs stamped peer rows as user; current CLIs stamp them as agent.
    it.each(['agent', 'user'] as const)('shows a peer delivery as sender-labelled agent text, never user input (messageRole=%s)', messageRole => {
        const normalized = normalizeRawMessage('peer', null, 1, peerOutput as never, { messageRole });
        const messages = reducer(createReducer(), normalized ? [normalized] : []).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ kind: 'agent-text', text: '**Verdict:** fixed.',
            peer: { name: 'general-purpose', handback: true } });
    });
});
