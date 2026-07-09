import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { buildForkAwareMessageDescriptors } from './buildForkAwareMessageDescriptors';

function message(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id };
}

describe('buildForkAwareMessageDescriptors', () => {
    it('preserves combined order and exposes stable fork boundary inputs', () => {
        const fork: ForkedTranscriptSnapshot = {
            segments: [
                { sessionId: 'root', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['r1', 'r2'] },
                { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: ['p1'] },
                { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c1'] },
            ],
            combinedMessageIdsOldestFirst: ['r1', 'r2', 'p1', 'c1'],
            combinedMessagesById: {
                r1: message('r1', 1),
                r2: message('r2', 2),
                p1: message('p1', 3),
                c1: message('c1', 4),
            },
            messageOriginById: {
                r1: { sessionId: 'root', isReadOnlyContext: true },
                r2: { sessionId: 'root', isReadOnlyContext: true },
                p1: { sessionId: 'parent', isReadOnlyContext: true },
                c1: { sessionId: 'child', isReadOnlyContext: false },
            },
            isLoaded: true,
        };

        const result = buildForkAwareMessageDescriptors(fork);

        expect(result.messageIdsOldestFirst).toEqual(['r1', 'r2', 'p1', 'c1']);
        expect([...result.forkBoundaryBeforeMessageIds]).toEqual(['p1', 'c1']);
        expect(result.forkBoundarySignature).toBe('p1|c1');
        expect(result.metadataByMessageId.p1).toEqual({
            messageId: 'p1',
            originSessionId: 'parent',
            isReadOnlyContext: true,
            segmentIndex: 1,
            hasForkBoundaryBefore: true,
        });
        expect(result.metadataByMessageId.c1?.isReadOnlyContext).toBe(false);
    });

    it('omits boundary ids for empty child segments while keeping a stable empty signature', () => {
        const fork: ForkedTranscriptSnapshot = {
            segments: [
                { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p1'] },
                { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
            ],
            combinedMessageIdsOldestFirst: ['p1'],
            combinedMessagesById: { p1: message('p1', 1) },
            messageOriginById: {
                p1: { sessionId: 'parent', isReadOnlyContext: true },
            },
            isLoaded: true,
        };

        const result = buildForkAwareMessageDescriptors(fork);

        expect([...result.forkBoundaryBeforeMessageIds]).toEqual([]);
        expect(result.forkBoundarySignature).toBe('');
        expect(result.metadataByMessageId.p1?.segmentIndex).toBe(0);
    });
});
