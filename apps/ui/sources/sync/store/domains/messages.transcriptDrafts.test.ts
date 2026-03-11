import { describe, expect, it } from 'vitest';

import { createMessagesDomain } from './messages';
import type { NormalizedMessage } from '../../typesRaw';

function createHarness(initial: any = {}) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

describe('messages domain: applyTranscriptDraftDelta', () => {
    it('accumulates draft delta text by localId', () => {
        const { get, domain } = createHarness();

        domain.applyTranscriptDraftDelta('s1', {
            localId: 'local-1',
            segmentKind: 'assistant',
            sidechainId: null,
            deltaText: 'Hello',
            createdAtMs: 10,
        });

        domain.applyTranscriptDraftDelta('s1', {
            localId: 'local-1',
            segmentKind: 'assistant',
            sidechainId: null,
            deltaText: ' world',
            createdAtMs: 20,
        });

        const sessionMessages = get().sessionMessages.s1;
        expect(sessionMessages.draftsByLocalId['local-1'].text).toBe('Hello world');
    });

    it('clears a matching transcript draft once the durable message arrives', () => {
        const { get, domain } = createHarness();

        domain.applyTranscriptDraftDelta('s1', {
            localId: 'local-1',
            segmentKind: 'assistant',
            sidechainId: null,
            deltaText: 'Hello',
            createdAtMs: 10,
        });

        const durableMessage: NormalizedMessage = {
            id: 'msg-1',
            localId: 'local-1',
            role: 'agent',
            createdAt: 20,
            isSidechain: false,
            content: [{ type: 'text', text: 'Hello', uuid: 'u-1', parentUUID: null }],
        };

        domain.applyMessages('s1', [durableMessage]);

        const sessionMessages = get().sessionMessages.s1;
        expect(sessionMessages.draftsByLocalId['local-1']).toBeUndefined();
    });
});
