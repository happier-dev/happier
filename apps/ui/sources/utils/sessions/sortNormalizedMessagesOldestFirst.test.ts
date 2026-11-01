import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';

import { sortNormalizedMessagesOldestFirst } from './sortNormalizedMessagesOldestFirst';

function msg(id: string, createdAt: number, seq?: number): NormalizedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [],
    };
}

describe('sortNormalizedMessagesOldestFirst', () => {
    it('sorts by createdAt ascending and uses id as deterministic tie-breaker', () => {
        const input: NormalizedMessage[] = [
            msg('b', 10),
            msg('a', 10),
            msg('c', 5),
        ];

        sortNormalizedMessagesOldestFirst(input);

        expect(input.map((m) => `${m.createdAt}:${m.id}`)).toEqual(['5:c', '10:a', '10:b']);
    });

    it('prefers seq ordering when both messages have seq', () => {
        const input: NormalizedMessage[] = [
            msg('b', 0, 2),
            msg('a', 100, 1),
        ];

        sortNormalizedMessagesOldestFirst(input);

        expect(input.map((m) => `${m.seq}:${m.createdAt}:${m.id}`)).toEqual(['1:100:a', '2:0:b']);
    });

    it('keeps committed sequence order when an unsequenced row has an intermediate timestamp', () => {
        const input = [msg('reply', 0, 2), msg('unsequenced', 50), msg('submitted', 100, 1)];

        sortNormalizedMessagesOldestFirst(input);

        expect(input.map((message) => message.id)).toEqual(['submitted', 'reply', 'unsequenced']);
    });
});
