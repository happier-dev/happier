import { describe, expect, it } from 'vitest';

import {
    isReleasedServerV021PendingEnqueueResponse,
    serializePendingEnqueueBodyForServerWire,
} from './pendingQueueV2';

const canonicalBody = JSON.stringify({
    localId: 'local-1',
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
    messageRole: 'user',
    requestedAction: { v: 1, kind: 'send_now' },
    deliveryMode: 'external_handoff',
});

describe('Pending queue server-wire serialization', () => {
    it('preserves the full canonical body for Pending-input v1', () => {
        expect(serializePendingEnqueueBodyForServerWire(canonicalBody, 'pending_input_v1')).toBe(canonicalBody);
    });

    it.each([
        [JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        }), {
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        }],
        [JSON.stringify({
            localId: 'local-2', ciphertext: 'ciphertext', messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        }), { localId: 'local-2', ciphertext: 'ciphertext' }],
    ])('serializes only the released-server envelope %#', (body, expected) => {
        const serialized = serializePendingEnqueueBodyForServerWire(body, 'released_server_v0_2_1');
        expect(serialized && JSON.parse(serialized)).toEqual(expected);
    });

    it('preserves surrounding whitespace in an accepted opaque localId', () => {
        const body = JSON.stringify({
            localId: ' opaque-local ',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        const serialized = serializePendingEnqueueBodyForServerWire(body, 'released_server_v0_2_1');
        expect(serialized && JSON.parse(serialized)).toMatchObject({ localId: ' opaque-local ' });
    });

    it.each([
        ['indeterminate' as const, canonicalBody],
        ['released_server_v0_2_1' as const, JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: null,
        })],
        ['released_server_v0_2_1' as const, JSON.stringify({ localId: 'local-1' })],
        ['released_server_v0_2_1' as const, JSON.stringify({
            localId: '   ',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
        })],
        ['released_server_v0_2_1' as const, 'not-json'],
    ])('fails closed for %s with an unsupported canonical body', (mode, body) => {
        expect(serializePendingEnqueueBodyForServerWire(body, mode)).toBeNull();
    });

    it.each([
        canonicalBody,
        JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'send_now' },
        }),
        JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
            deliveryMode: 'external_handoff',
        }),
    ])('rejects a final-only action with an explicit upgrade-required contract', (body) => {
        expect(() => serializePendingEnqueueBodyForServerWire(
            body,
            'released_server_v0_2_1',
        )).toThrow(expect.objectContaining({ code: 'server-upgrade-required' }));
    });
});

const releasedServerAck = {
    didWrite: true,
    pending: {
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        status: 'queued',
        position: 1,
        createdAt: 1_000,
        updatedAt: 1_001,
        discardedAt: null,
        discardedReason: null,
        authorAccountId: 'account-1',
    },
    pendingCount: 1,
    pendingVersion: 2,
};

describe('released server v0.2.1 Pending enqueue response parsing', () => {
    it('accepts the immutable released-server response shape for the exact local id', () => {
        expect(isReleasedServerV021PendingEnqueueResponse(releasedServerAck, 'local-1')).toBe(true);
        expect(isReleasedServerV021PendingEnqueueResponse({ ...releasedServerAck, didWrite: false }, 'local-1')).toBe(true);
    });

    it.each([
        null,
        { ...releasedServerAck, didWrite: 'true' },
        { ...releasedServerAck, unexpected: true },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, localId: 'other-local' } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, unexpected: true } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, content: null } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, status: 'delivering' } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, authorAccountId: null } },
        { ...releasedServerAck, pendingCount: -1 },
        { ...releasedServerAck, pendingVersion: 1.5 },
    ])('rejects a non-released or mismatched acknowledgement %#', (payload) => {
        expect(isReleasedServerV021PendingEnqueueResponse(payload, 'local-1')).toBe(false);
    });
});
