import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadRawSessionDraftValues } from '@/sync/domains/state/sessionDraftValuesPersistence';
import { sessionDraftValuesStorageKey } from '@/sync/domains/state/sessionLocalStateKeys';

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

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import {
    SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
    SESSION_DRAFT_VALUE_FIELD_CATALOG,
} from './sessionDraftValueFieldCatalog';
import {
    clearSessionDraftValue,
    clearSessionDraftValuesForSession,
    flushSessionDraftValues,
    garbageCollectSessionDraftValues,
    invalidateSessionDraftValueCache,
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from './sessionDraftValueStore';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

describe('session draft value store', () => {
    beforeEach(() => {
        store.clear();
        resetSessionDraftValueCachesForTests();
    });

    it('declares the semantic fields owned by AgentInput drafts', () => {
        expect(Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG).sort()).toEqual([
            'routing.executionRunDelivery',
            'routing.recipient',
            'structuredInput.mentions',
        ]);
        expect(SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS).toBe(30);
    });

    it('roundtrips registered values through a scoped in-memory cache and raw persistence', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(readSessionDraftValue(scopeB, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('distinguishes explicit null recipient from a missing draft value', () => {
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();

        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', null, 100);
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeNull();

        clearSessionDraftValue(scopeA, 'session-1', 'routing.recipient');
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
    });

    it('does not churn persisted values for unchanged writes or missing clears', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);

        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 200);
        clearSessionDraftValue(scopeA, 'session-1', 'routing.recipient');
        flushSessionDraftValues(scopeA);

        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('salvages valid persisted fields and drops malformed envelopes without dirtying valid entries', () => {
        store.set(sessionDraftValuesStorageKey(scopeA), JSON.stringify({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
                'routing.recipient': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: { kind: 'missing' },
                },
                'unknown.field': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: true,
                },
            },
        }));

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();

        flushSessionDraftValues(scopeA);
        expect(JSON.parse(store.get(sessionDraftValuesStorageKey(scopeA)) ?? '{}')).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('clears values by lifecycle without clearing unrelated fields', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [], 100);

        clearSessionDraftValuesForSession(scopeA, 'session-1', { reason: 'composerClear' });

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toBeUndefined();
    });

    it('clears routing values at outbound handoff', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', null, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);

        clearSessionDraftValuesForSession(scopeA, 'session-1', { reason: 'send' });

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
    });

    it('garbage-collects stale values according to field TTL metadata', () => {
        const now = 100 + SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000 + 1;
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [], 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', now);

        garbageCollectSessionDraftValues(scopeA, { now });

        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
    });

    it('flushes pending writes before switching owners by exposing explicit invalidation and flush controls', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');

        clearSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery');
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
    });
});
