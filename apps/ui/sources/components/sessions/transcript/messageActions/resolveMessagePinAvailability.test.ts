import { describe, expect, it } from 'vitest';

import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

import {
    buildSessionMessagePinAtPressTime,
    resolveMessagePinAvailability,
} from './resolveMessagePinAvailability';

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 's1',
        seq: 5,
        transcriptBlockIndex: 0,
        routeMessageId: 'server:message-5',
        role: 'assistant',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

describe('resolveMessagePinAvailability', () => {
    it('prefers stable route ids while preserving row proof fields, without stamping a render-time pin', () => {
        const availability = resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 7,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-7',
            role: 'assistant',
            pins: [],
        });

        expect(availability.status).toBe('available');
        if (availability.status !== 'available') {
            throw new Error('Expected available message pin target');
        }
        expect(availability.pinTarget).toEqual({
            version: 1,
            sessionId: 's1',
            seq: 7,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-7',
            role: 'assistant',
            label: null,
        });
        expect(availability.identityKey).toBe('route-message-id|s1|server:message-7|block:2|assistant');
        expect(availability.pinned).toBe(false);
    });

    it('stamps pinnedAtMs at press time, not while the row renders', () => {
        const availability = resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 7,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-7',
            role: 'assistant',
            pins: [],
        });
        if (availability.status !== 'available') {
            throw new Error('Expected available message pin target');
        }

        expect(buildSessionMessagePinAtPressTime(availability.pinTarget, 4_242)).toEqual({
            version: 1,
            sessionId: 's1',
            seq: 7,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-7',
            role: 'assistant',
            pinnedAtMs: 4_242,
            label: null,
        });
        expect(buildSessionMessagePinAtPressTime(availability.pinTarget, Number.NaN).pinnedAtMs)
            .toBeGreaterThan(0);
    });

    it('falls back to seq, block index, and role when no stable route id is available', () => {
        const availability = resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 8,
            transcriptBlockIndex: null,
            routeMessageId: 'temporary-message-id',
            role: 'user',
            pins: [],
        });

        expect(availability.status).toBe('available');
        if (availability.status !== 'available') {
            throw new Error('Expected fallback pin target');
        }
        expect(availability.pinTarget.routeMessageId).toBeNull();
        expect(availability.identityKey).toBe('fallback|s1|8|block:null|user');
    });

    it('marks matching existing pins without collapsing same-route different-block rows', () => {
        const pins = [
            pin({ transcriptBlockIndex: 0, role: 'assistant' }),
            pin({ transcriptBlockIndex: 1, role: 'tool' }),
        ];

        const sameRow = resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 5,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-5',
            role: 'assistant',
            pins,
        });
        const differentRow = resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 5,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-5',
            role: 'assistant',
            pins,
        });

        expect(sameRow.status === 'available' ? sameRow.pinned : null).toBe(true);
        expect(differentRow.status === 'available' ? differentRow.pinned : null).toBe(false);
    });

    it('requires a valid seq for message and tool pin targets', () => {
        expect(resolveMessagePinAvailability({
            sessionId: 's1',
            seq: null,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-5',
            role: 'assistant',
            pins: [],
        })).toEqual({ status: 'unavailable', reason: 'missing-seq' });

        expect(resolveMessagePinAvailability({
            sessionId: 's1',
            seq: Number.POSITIVE_INFINITY,
            transcriptBlockIndex: 0,
            routeMessageId: 'tool:call-1',
            role: 'tool',
            pins: [],
        })).toEqual({ status: 'unavailable', reason: 'missing-seq' });
    });

    it('rejects non-pinnable roles', () => {
        expect(resolveMessagePinAvailability({
            sessionId: 's1',
            seq: 9,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-9',
            role: 'system',
            pins: [],
        })).toEqual({ status: 'unavailable', reason: 'unsupported-role' });
    });

    it('disables pins for read-only fork transcript contexts so they cannot be saved under the display session', () => {
        expect(resolveMessagePinAvailability({
            sessionId: 'origin-session',
            displaySessionId: 'fork-session',
            readOnlyContext: true,
            seq: 9,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-9',
            role: 'assistant',
            pins: [],
        })).toEqual({ status: 'unavailable', reason: 'read-only-context' });
    });
});
