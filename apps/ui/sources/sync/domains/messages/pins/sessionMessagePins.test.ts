import { describe, expect, it } from 'vitest';

import {
    addSessionMessagePin,
    removeSessionMessagePin,
    reconcileSessionMessagePinRouteId,
    reconcileSessionMessagePinRouteIds,
    toggleSessionMessagePin,
    type PersistedSessionMessagePinV1,
} from './sessionMessagePins';
import { buildSessionMessagePinIdentity } from './sessionMessagePinIdentity';

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 'session-1',
        seq: 10,
        transcriptBlockIndex: 0,
        routeMessageId: null,
        role: 'user',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

describe('session message pins', () => {
    it('adds pins in chronological row order without collapsing co-seq rows', () => {
        const pins = [
            pin({ seq: 7, transcriptBlockIndex: 2, role: 'tool', pinnedAtMs: 3_000 }),
            pin({ seq: 5, transcriptBlockIndex: 1, role: 'assistant', pinnedAtMs: 2_000 }),
            pin({ seq: 5, transcriptBlockIndex: 0, role: 'user', pinnedAtMs: 1_000 }),
        ].reduce((current, next) => addSessionMessagePin(current, next), [] as readonly PersistedSessionMessagePinV1[]);

        expect(pins).toEqual([
            pin({ seq: 5, transcriptBlockIndex: 0, role: 'user', pinnedAtMs: 1_000 }),
            pin({ seq: 5, transcriptBlockIndex: 1, role: 'assistant', pinnedAtMs: 2_000 }),
            pin({ seq: 7, transcriptBlockIndex: 2, role: 'tool', pinnedAtMs: 3_000 }),
        ]);
    });

    it('returns the same array reference when adding an existing pin without better identity metadata', () => {
        const existing = [pin({ routeMessageId: 'server:message-10' })] as const;

        expect(addSessionMessagePin(existing, pin({ routeMessageId: 'server:message-10' }))).toBe(existing);
    });

    it('keeps separate pins for flattened rows sharing one stable route message id', () => {
        const assistantBlock = pin({
            seq: 24,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-24',
            role: 'assistant',
            pinnedAtMs: 1_000,
        });
        const toolBlock = pin({
            seq: 24,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-24',
            role: 'tool',
            pinnedAtMs: 2_000,
        });

        const pins = [assistantBlock, toolBlock].reduce(
            (current, next) => addSessionMessagePin(current, next),
            [] as readonly PersistedSessionMessagePinV1[],
        );

        expect(pins).toEqual([assistantBlock, toolBlock]);
    });

    it('removes only the requested fallback row when several rows share one seq', () => {
        const pins = [
            pin({ seq: 12, transcriptBlockIndex: 0, role: 'user' }),
            pin({ seq: 12, transcriptBlockIndex: 1, role: 'assistant' }),
            pin({ seq: 12, transcriptBlockIndex: 2, role: 'tool' }),
        ];
        const assistantIdentity = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 12,
            transcriptBlockIndex: 1,
            routeMessageId: null,
            role: 'assistant',
        });

        expect(assistantIdentity?.kind).toBe('fallback');
        const next = assistantIdentity ? removeSessionMessagePin(pins, assistantIdentity) : pins;

        expect(next).toEqual([
            pin({ seq: 12, transcriptBlockIndex: 0, role: 'user' }),
            pin({ seq: 12, transcriptBlockIndex: 2, role: 'tool' }),
        ]);
    });

    it('toggles by row identity: absent pins are added and present pins are removed', () => {
        const userPin = pin({ seq: 21, transcriptBlockIndex: 0, role: 'user' });
        const added = toggleSessionMessagePin([], userPin);
        expect(added).toEqual([userPin]);
        expect(toggleSessionMessagePin(added, userPin)).toEqual([]);
    });

    it('toggles local and server route ids for the same fallback row as one pin target', () => {
        const local = pin({
            seq: 22,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:temp-22',
            role: 'assistant',
        });
        const hydratedServerRow = pin({
            seq: 22,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-22',
            role: 'assistant',
        });

        expect(toggleSessionMessagePin([local], hydratedServerRow)).toEqual([]);
    });

    it('toggles only the requested flattened row when stable route message ids are shared', () => {
        const firstBlock = pin({
            seq: 25,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-25',
            role: 'assistant',
            pinnedAtMs: 1_000,
        });
        const secondBlock = pin({
            seq: 25,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-25',
            role: 'assistant',
            pinnedAtMs: 2_000,
        });

        expect(toggleSessionMessagePin([firstBlock, secondBlock], firstBlock)).toEqual([secondBlock]);
    });

    it('removes only the requested flattened row when stable route message ids are shared', () => {
        const firstBlock = pin({
            seq: 26,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-26',
            role: 'assistant',
            pinnedAtMs: 1_000,
        });
        const secondBlock = pin({
            seq: 26,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-26',
            role: 'assistant',
            pinnedAtMs: 2_000,
        });
        const firstIdentity = buildSessionMessagePinIdentity(firstBlock);

        expect(firstIdentity).not.toBeNull();
        expect(firstIdentity ? removeSessionMessagePin([firstBlock, secondBlock], firstIdentity) : []).toEqual([secondBlock]);
    });

    it('reconciles local route ids to server route ids via fallback identity without losing seq', () => {
        const local = pin({
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:temp-31',
            role: 'assistant',
            pinnedAtMs: 5_000,
        });
        const server = pin({
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-31',
            role: 'assistant',
            pinnedAtMs: 9_000,
        });

        expect(addSessionMessagePin([local], server)).toEqual([{
            ...local,
            routeMessageId: 'server:message-31',
        }]);
        expect(reconcileSessionMessagePinRouteId(local, 'server:message-31')).toEqual({
            ...local,
            routeMessageId: 'server:message-31',
        });
    });

    it('pin local-id upgraded with seq correction adopts new seq', () => {
        const local = pin({
            seq: 44,
            transcriptBlockIndex: 2,
            routeMessageId: 'local:local-45',
            role: 'tool',
            pinnedAtMs: 5_000,
        });

        expect(reconcileSessionMessagePinRouteIds([local], [{
            seq: 45,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-45',
            previousRouteMessageIds: ['local:local-45'],
            role: 'tool',
        }])).toEqual([{
            ...local,
            seq: 45,
            routeMessageId: 'server:message-45',
        }]);
    });

    it('ignores invalid pin records instead of creating unjumpable pins', () => {
        const pins = [] as readonly PersistedSessionMessagePinV1[];

        expect(addSessionMessagePin(pins, pin({ sessionId: '', seq: 1 }))).toBe(pins);
        expect(addSessionMessagePin(pins, pin({ seq: Number.POSITIVE_INFINITY }))).toBe(pins);
    });

    it('returns the same array reference when removing an absent identity', () => {
        const pins = [pin({ seq: 4, transcriptBlockIndex: 0, role: 'user' })] as const;
        const absent = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 4,
            transcriptBlockIndex: 1,
            routeMessageId: null,
            role: 'assistant',
        });

        expect(absent).not.toBeNull();
        expect(absent ? removeSessionMessagePin(pins, absent) : pins).toBe(pins);
    });
});
