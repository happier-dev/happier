import { describe, expect, it, vi } from 'vitest';

import type { SessionDraftDocumentV1 } from '@happier-dev/protocol';

import { createExistingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import {
    isEmptyPendingMessageComposerSemanticDraftSnapshot,
    readPendingMessageComposerSemanticDraftSnapshot,
} from './pendingMessageComposerEditSnapshot';

const field = <T,>(mutationId: string, value: T) => ({ mutationId, value });
const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

/**
 * The real semantic-value owner over a repository that holds exactly `document` for `s1`.
 * The repository is the boundary here and the reader only consumes `snapshot.document`, so the
 * stub snapshot and flush result are partial on purpose.
 */
function valuesHolding(document: SessionDraftDocumentV1) {
    return createExistingSessionDraftSemanticValues({
        getSessionDraftSnapshot: (_scope, address) => (
            address.kind === 'session' && address.sessionId === 's1' ? { document } as any : null
        ),
        subscribeSessionDraft: vi.fn(() => () => undefined),
        writeExistingSessionDraft: vi.fn(),
        flushSessionDraft: vi.fn(async () => ({ status: 'clean' })) as any,
    });
}

describe('readPendingMessageComposerSemanticDraftSnapshot', () => {
    it('treats canonical default routing and empty mentions as semantically empty', () => {
        expect(isEmptyPendingMessageComposerSemanticDraftSnapshot({
            recipient: null,
            executionRunDelivery: undefined,
            structuredInputMentions: [],
        })).toBe(true);
    });

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

        expect(readPendingMessageComposerSemanticDraftSnapshot(valuesHolding(document), scope, 's1')).toEqual({
            recipient: null,
            executionRunDelivery: 'interrupt',
            structuredInputMentions: [{ kind: 'skill', name: 'review', tokenText: '$review' }],
        });
    });

    it('reads nothing without an account scope', () => {
        expect(readPendingMessageComposerSemanticDraftSnapshot({ read: vi.fn() }, null, 's1')).toEqual({
            recipient: undefined,
            executionRunDelivery: undefined,
            structuredInputMentions: undefined,
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

        expect(readPendingMessageComposerSemanticDraftSnapshot(valuesHolding(document), scope, 's1')).toEqual({
            recipient: undefined,
            executionRunDelivery: undefined,
            structuredInputMentions: [],
        });
    });
});
