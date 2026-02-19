import { describe, expect, it } from 'vitest';

import { createReducer } from './reducer';
import { runUserAndTextPhase } from './phases/userAndText';

describe('runUserAndTextPhase (streaming merge)', () => {
    it('merges consecutive root agent text chunks when happierStreamKey matches', () => {
        const state = createReducer();
        const changed = new Set<string>();
        let nextId = 0;
        const allocateId = () => `m_${++nextId}`;

        const streamKey = 'stream:turn:1';
        const now = 1_700_000_000_000;

        runUserAndTextPhase({
            state,
            nonSidechainMessages: [
                {
                    id: 'a1',
                    localId: null,
                    createdAt: now,
                    isSidechain: false,
                    role: 'agent',
                    content: [{ type: 'text', text: 'Hello', uuid: 'u1', parentUUID: null }],
                    meta: { happierStreamKey: streamKey },
                },
                {
                    id: 'a2',
                    localId: null,
                    createdAt: now + 1,
                    isSidechain: false,
                    role: 'agent',
                    content: [{ type: 'text', text: ' world', uuid: 'u2', parentUUID: null }],
                    meta: { happierStreamKey: streamKey },
                },
            ],
            changed,
            allocateId,
            processUsageData: () => {},
            lastMainThinkingMessageId: null,
            lastMainStreamMessageId: null,
            lastMainStreamKey: null,
            isPermissionRequestToolCall: () => false,
        });

        const agentMessages = [...state.messages.values()].filter((m) => m.role === 'agent' && typeof m.text === 'string');
        expect(agentMessages).toHaveLength(1);
        expect(agentMessages[0]?.text).toBe('Hello world');
    });
});
