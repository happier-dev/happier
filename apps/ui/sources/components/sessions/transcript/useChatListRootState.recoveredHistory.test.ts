import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    resolveExternalSessionOperationMachineSubscriptionTarget,
    resolveLatestCommittedActivityKey,
} from './useChatListRootState';

function agentText(id: string, overrides: Partial<Message> = {}): Message {
    return {
        id,
        kind: 'agent-text',
        localId: null,
        createdAt: 1_000,
        seq: 1,
        text: id,
        ...overrides,
    } as Message;
}

describe('resolveLatestCommittedActivityKey', () => {
    it('keeps recovered history from becoming tail-follow activity while live messages still advance once', () => {
        const live = agentText('live', { seq: 1 });
        const history = agentText('history', {
            seq: 2,
            sourceCreatedAt: 100,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        });
        const nextLive = agentText('next-live', { seq: 3 });
        const messagesById = { live, history, 'next-live': nextLive };

        expect(resolveLatestCommittedActivityKey({ messageIdsOldestFirst: ['live'], messagesById })).toBe('live');
        expect(resolveLatestCommittedActivityKey({ messageIdsOldestFirst: ['live', 'history'], messagesById })).toBe('live');
        expect(resolveLatestCommittedActivityKey({
            messageIdsOldestFirst: ['live', 'history', 'next-live'],
            messagesById,
        })).toBe('next-live');
    });
});

describe('resolveExternalSessionOperationMachineSubscriptionTarget', () => {
    it.each([
        ['no operation presentation', true, false, 'machine-1', null],
        ['non-owner reader', false, true, 'machine-1', null],
        ['owner without a machine target', true, true, null, null],
        ['exact owner operation', true, true, 'machine-1', 'machine-1'],
    ] as const)('%s', (
        _label,
        isExactOwner,
        hasPresentation,
        machineId,
        expected,
    ) => {
        expect(resolveExternalSessionOperationMachineSubscriptionTarget({
            hasPresentation,
            isExactOwner,
            machineId,
        })).toBe(expected);
    });
});
