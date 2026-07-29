import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '../scope/serverAccountScope';
import type { PersistedSessionMessagePinV1 } from '../messages/pins/sessionMessagePins';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import {
    clearPersistedSessionMessagePins,
    clearPersistedSessionMessagePinsStorage,
    loadPersistedSessionMessagePins,
    readPersistedSessionMessagePins,
    reconcilePersistedSessionMessagePinRouteIds,
    savePersistedSessionMessagePins,
    sessionMessagePinsStorageKey,
    subscribeSessionMessagePinsChanges,
} from './sessionMessagePinsPersistence';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 'session-1',
        seq: 10,
        transcriptBlockIndex: 0,
        routeMessageId: 'server:message-10',
        role: 'user',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

describe('session message pins persistence', () => {
    beforeEach(() => {
        store.clear();
    });

    it('uses the same server-account scoped key discipline as session viewport persistence', () => {
        expect(sessionMessagePinsStorageKey()).toBe('session-message-pins-v1');
        expect(sessionMessagePinsStorageKey(scopeA)).toBe(
            'session-message-pins-v1:scope:v2:8:server-a9:account-a',
        );
        expect(sessionMessagePinsStorageKey(scopeB)).toBe(
            'session-message-pins-v1:scope:v2:8:server-a9:account-b',
        );
    });

    it('round-trips pins per session without leaking across server-account scopes', () => {
        const session1Pins = [
            pin({ sessionId: 'session-1', seq: 1, routeMessageId: 'server:message-1' }),
            pin({ sessionId: 'session-1', seq: 2, routeMessageId: 'server:message-2' }),
        ];
        const session2Pins = [pin({ sessionId: 'session-2', seq: 1, routeMessageId: 'server:message-a' })];

        savePersistedSessionMessagePins('session-1', session1Pins, scopeA);
        savePersistedSessionMessagePins('session-2', session2Pins, scopeA);

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual(session1Pins);
        expect(readPersistedSessionMessagePins('session-2', scopeA)).toEqual(session2Pins);
        expect(readPersistedSessionMessagePins('session-1', scopeB)).toEqual([]);
        expect(readPersistedSessionMessagePins('session-1')).toEqual([]);
    });

    it('returns an empty payload for corrupt JSON and sanitizes malformed sibling records', () => {
        store.set(sessionMessagePinsStorageKey(scopeA), 'not-json');
        expect(loadPersistedSessionMessagePins(scopeA)).toEqual({});

        store.set(sessionMessagePinsStorageKey(scopeA), JSON.stringify({
            version: 1,
            sessions: {
                'session-1': [
                    pin({ sessionId: 'session-1' }),
                    pin({ sessionId: 'session-1', seq: Number.NaN }),
                    { ...pin({ sessionId: 'session-1', seq: 11 }), version: 2 },
                ],
                'session-2': 'bad',
            },
        }));

        expect(loadPersistedSessionMessagePins(scopeA)).toEqual({
            'session-1': [pin({ sessionId: 'session-1' })],
        });
    });

    it('does not silently evict pins by applying an arbitrary per-session cap', () => {
        const manyPins = Array.from({ length: 140 }, (_, index) => pin({
            sessionId: 'session-many',
            seq: index + 1,
            transcriptBlockIndex: index,
            routeMessageId: `server:message-${index + 1}`,
            pinnedAtMs: index,
        }));

        savePersistedSessionMessagePins('session-many', manyPins, scopeA);

        expect(readPersistedSessionMessagePins('session-many', scopeA)).toHaveLength(140);
    });

    it('writes only the persisted V1 fields and never stores plaintext previews', () => {
        savePersistedSessionMessagePins('session-1', [
            {
                ...pin({ label: 'local label' }),
                promptPreview: 'do not store me',
                responsePreview: 'do not store me either',
            } as PersistedSessionMessagePinV1,
        ], scopeA);

        const raw = store.get(sessionMessagePinsStorageKey(scopeA));
        expect(raw).toBeTruthy();
        expect(raw).not.toContain('promptPreview');
        expect(raw).not.toContain('responsePreview');
        expect(JSON.parse(raw ?? '{}')).toEqual({
            version: 1,
            sessions: {
                'session-1': [pin({ label: 'local label' })],
            },
        });
    });

    it('normalizes labels at the persistence write boundary', () => {
        const longLabel = `  ${'x'.repeat(140)}  `;

        savePersistedSessionMessagePins('session-1', [pin({ label: longLabel })], scopeA);

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([
            pin({ label: 'x'.repeat(120) }),
        ]);
    });

    it('reconciles persisted local route pins when hydration exposes the server route id without duplicating re-pins', () => {
        const localPin = pin({
            sessionId: 'session-1',
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:local-31',
            role: 'assistant',
            pinnedAtMs: 2_000,
        });
        savePersistedSessionMessagePins('session-1', [localPin], scopeA);

        const didReconcile = reconcilePersistedSessionMessagePinRouteIds('session-1', [{
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-31',
            role: 'assistant',
        }], scopeA);

        expect(didReconcile).toBe(true);
        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([{
            ...localPin,
            routeMessageId: 'server:message-31',
        }]);

        expect(reconcilePersistedSessionMessagePinRouteIds('session-1', [{
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-31',
            role: 'assistant',
        }], scopeA)).toBe(false);

        savePersistedSessionMessagePins('session-1', [
            ...readPersistedSessionMessagePins('session-1', scopeA),
            pin({
                sessionId: 'session-1',
                seq: 31,
                transcriptBlockIndex: 1,
                routeMessageId: 'server:message-31',
                role: 'assistant',
                pinnedAtMs: 9_000,
            }),
        ], scopeA);

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([{
            ...localPin,
            routeMessageId: 'server:message-31',
        }]);
    });

    it('reconciles local route pins even when hydration corrects the seq locator at the same time', () => {
        const localPin = pin({
            sessionId: 'session-1',
            seq: 30,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:local-31',
            role: 'assistant',
            pinnedAtMs: 2_000,
        });
        savePersistedSessionMessagePins('session-1', [localPin], scopeA);

        expect(reconcilePersistedSessionMessagePinRouteIds('session-1', [{
            seq: 31,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-31',
            previousRouteMessageIds: ['local:local-31'],
            role: 'assistant',
        }], scopeA)).toBe(true);

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([{
            ...localPin,
            seq: 31,
            routeMessageId: 'server:message-31',
        }]);
    });

    it('pin local-id upgraded with seq correction adopts new seq', () => {
        const localPin = pin({
            sessionId: 'session-1',
            seq: 44,
            transcriptBlockIndex: 2,
            routeMessageId: 'local:local-45',
            role: 'tool',
            pinnedAtMs: 3_000,
        });
        savePersistedSessionMessagePins('session-1', [localPin], scopeA);

        expect(reconcilePersistedSessionMessagePinRouteIds('session-1', [{
            seq: 45,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-45',
            previousRouteMessageIds: ['local:local-45'],
            role: 'tool',
        }], scopeA)).toBe(true);

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([{
            ...localPin,
            seq: 45,
            routeMessageId: 'server:message-45',
        }]);
    });

    it('reconcile route-id upgrade emits a change notification', () => {
        const localPin = pin({
            sessionId: 'session-1',
            seq: 30,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:local-31',
            role: 'assistant',
            pinnedAtMs: 2_000,
        });
        savePersistedSessionMessagePins('session-1', [localPin], scopeA);
        const listener = vi.fn();
        const unsubscribe = subscribeSessionMessagePinsChanges(listener);

        try {
            expect(reconcilePersistedSessionMessagePinRouteIds('session-1', [{
                seq: 31,
                transcriptBlockIndex: 1,
                routeMessageId: 'server:message-31',
                previousRouteMessageIds: ['local:local-31'],
                role: 'assistant',
            }], scopeA)).toBe(true);

            expect(listener).toHaveBeenCalledTimes(1);

            expect(reconcilePersistedSessionMessagePinRouteIds('session-1', [{
                seq: 31,
                transcriptBlockIndex: 1,
                routeMessageId: 'server:message-31',
                previousRouteMessageIds: ['local:local-31'],
                role: 'assistant',
            }], scopeA)).toBe(false);

            expect(listener).toHaveBeenCalledTimes(1);
        } finally {
            unsubscribe();
        }
    });

    it('keeps an explicit migration stub by accepting only known payload versions', () => {
        store.set(sessionMessagePinsStorageKey(scopeA), JSON.stringify({
            version: 99,
            sessions: {
                'session-1': [pin()],
            },
        }));

        expect(loadPersistedSessionMessagePins(scopeA)).toEqual({});
    });

    it('clears one session and deletes the scoped storage key when empty', () => {
        savePersistedSessionMessagePins('session-1', [pin({ sessionId: 'session-1' })], scopeA);
        savePersistedSessionMessagePins('session-2', [pin({ sessionId: 'session-2' })], scopeA);

        clearPersistedSessionMessagePins('session-1', scopeA);
        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([]);
        expect(readPersistedSessionMessagePins('session-2', scopeA)).toHaveLength(1);

        clearPersistedSessionMessagePins('session-2', scopeA);
        expect(store.has(sessionMessagePinsStorageKey(scopeA))).toBe(false);
    });

    it('clears all message pin records for one scope', () => {
        savePersistedSessionMessagePins('session-1', [pin()], scopeA);
        clearPersistedSessionMessagePinsStorage(scopeA);

        expect(loadPersistedSessionMessagePins(scopeA)).toEqual({});
    });
});
