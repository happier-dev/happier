import { describe, expect, it } from 'vitest';

import { resolveLatestCommittedMessageId } from './resolveLatestCommittedMessageId';

describe('resolveLatestCommittedMessageId', () => {
    it('returns the last committed message id without considering draft tails', () => {
        expect(resolveLatestCommittedMessageId([])).toBeNull();
        expect(resolveLatestCommittedMessageId([
            { kind: 'agent-text', id: 'committed-1', localId: null, createdAt: 1, text: 'one', isThinking: false },
            { kind: 'agent-text', id: 'thinking-1', localId: null, createdAt: 2, text: 'two', isThinking: true },
        ])).toBe('thinking-1');
    });
});
