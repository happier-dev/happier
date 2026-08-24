import { describe, expect, it } from 'vitest';

import type { SessionDraftDocumentV1 } from '@happier-dev/protocol';

import { readPendingMessageComposerSemanticDraftSnapshot } from './pendingMessageComposerEditSnapshot';

const field = <T,>(mutationId: string, value: T) => ({ mutationId, value });

describe('readPendingMessageComposerSemanticDraftSnapshot', () => {
    it('projects only recognized canonical semantic values', () => {
        const document: SessionDraftDocumentV1 = {
            v: 1,
            composer: {
                text: field('00000000-0000-4000-8000-000000000001', 'hello'),
                mentions: field('00000000-0000-4000-8000-000000000002', [{ kind: 'skill', name: 'review', tokenText: '$review' }]),
                attachments: field('00000000-0000-4000-8000-000000000003', []),
            },
            target: {
                kind: 'session',
                routing: {
                    recipient: field('00000000-0000-4000-8000-000000000004', { mode: 'manual', recipient: null }),
                    agentContinuation: field('00000000-0000-4000-8000-000000000005', null),
                    executionRunDelivery: field('00000000-0000-4000-8000-000000000006', 'interrupt'),
                },
            },
            extensions: {},
        };

        expect(readPendingMessageComposerSemanticDraftSnapshot(document)).toEqual({
            recipient: null,
            executionRunDelivery: 'interrupt',
            structuredInputMentions: [{ kind: 'skill', name: 'review', tokenText: '$review' }],
        });
    });

    it('does not execute unknown routing values', () => {
        const document: SessionDraftDocumentV1 = {
            v: 1,
            composer: {
                text: field('00000000-0000-4000-8000-000000000011', ''),
                mentions: field('00000000-0000-4000-8000-000000000012', []),
                attachments: field('00000000-0000-4000-8000-000000000013', []),
            },
            target: {
                kind: 'session',
                routing: {
                    recipient: field('00000000-0000-4000-8000-000000000014', { mode: 'future' }),
                    agentContinuation: field('00000000-0000-4000-8000-000000000015', null),
                    executionRunDelivery: field('00000000-0000-4000-8000-000000000016', 'future-mode'),
                },
            },
            extensions: {},
        };

        expect(readPendingMessageComposerSemanticDraftSnapshot(document)).toEqual({
            recipient: undefined,
            executionRunDelivery: undefined,
            structuredInputMentions: [],
        });
    });
});
