import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { loadRawAgentInputLocalUiState } from '@/sync/domains/state/agentInputLocalUiStatePersistence';
import { agentInputLocalUiStateStorageKey } from '@/sync/domains/state/sessionLocalStateKeys';

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
    AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS,
    agentInputDraftOwnerKey,
    clearAgentInputLocalUiStateForNewSession,
    clearAgentInputLocalUiStateForSession,
    flushAgentInputLocalUiState,
    garbageCollectAgentInputLocalUiState,
    invalidateAgentInputLocalUiStateCache,
    patchAgentInputLocalUiState,
    readAgentInputLocalUiState,
    resetAgentInputLocalUiStateCachesForTests,
} from './agentInputLocalUiStateStore';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

describe('agent input local UI state store', () => {
    beforeEach(() => {
        clearPersistence();
        resetAgentInputLocalUiStateCachesForTests();
    });

    it('keys owners by surface so sessions and new-session flows cannot collide', () => {
        expect(agentInputDraftOwnerKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
        expect(agentInputDraftOwnerKey({ kind: 'newSession', flowId: 'f1' })).toBe('new-session:f1');
        expect(AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS).toBe(7);
    });

    it('normalizes owner ids and rejects blank owners before touching persistence', () => {
        expect(agentInputDraftOwnerKey({ kind: 'session', sessionId: '  s1  ' })).toBe('session:s1');
        expect(agentInputDraftOwnerKey({ kind: 'newSession', flowId: '  f1  ' })).toBe('new-session:f1');
        expect(agentInputDraftOwnerKey({ kind: 'session', sessionId: '   ' })).toBeNull();

        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: '   ' }, { expanded: true }, 100);
        flushAgentInputLocalUiState(scopeA);

        expect(store.has(agentInputLocalUiStateStorageKey(scopeA))).toBe(false);
    });

    it('does not persist empty patches or missing clears', () => {
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {}, 100);
        clearAgentInputLocalUiStateForSession(scopeA, 'missing');
        flushAgentInputLocalUiState(scopeA);

        expect(store.has(agentInputLocalUiStateStorageKey(scopeA))).toBe(false);
    });

    it('roundtrips scoped expansion and web scroll state', () => {
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {
            expanded: true,
            scrollY: 120,
            selection: { start: 14, end: 14 },
            textLength: 180,
            fontScale: 1,
        }, 100);
        flushAgentInputLocalUiState(scopeA);

        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' })).toEqual({
            v: 1,
            expanded: true,
            scrollY: 120,
            selection: { start: 14, end: 14 },
            textLength: 180,
            fontScale: 1,
            updatedAt: 100,
        });
        expect(readAgentInputLocalUiState(scopeB, { kind: 'session', sessionId: 's1' })).toBeNull();
        expect(loadRawAgentInputLocalUiState(scopeA)).toEqual({
            'session:s1': {
                v: 1,
                expanded: true,
                scrollY: 120,
                selection: { start: 14, end: 14 },
                textLength: 180,
                fontScale: 1,
                updatedAt: 100,
            },
        });
    });

    it('invalidates stale scroll when font scale or text length drift makes pixel restore unsafe', () => {
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {
            scrollY: 120,
            textLength: 180,
            fontScale: 1,
        }, 100);

        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {
            textLength: 181,
            fontScale: 1.25,
        })).toEqual({
            v: 1,
            textLength: 180,
            fontScale: 1,
            updatedAt: 100,
        });
    });

    it('clamps restored selection to the current text length', () => {
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {
            selection: { start: 30, end: 40 },
            textLength: 100,
        }, 100);

        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, {
            textLength: 12,
        })?.selection).toEqual({ start: 12, end: 12 });
    });

    it('drops unsupported persisted owner namespaces and clamps selection ranges', () => {
        store.set(agentInputLocalUiStateStorageKey(scopeA), JSON.stringify({
            'message-details:s1': { v: 1, expanded: true, updatedAt: 100 },
            'session:s1': {
                v: 1,
                scrollY: -10,
                selection: { start: -20, end: 999 },
                textLength: 12,
                updatedAt: 100,
            },
        }));

        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' })).toEqual({
            v: 1,
            selection: { start: 0, end: 12 },
            textLength: 12,
            updatedAt: 100,
        });
        flushAgentInputLocalUiState(scopeA);
        expect(loadRawAgentInputLocalUiState(scopeA)).toEqual({
            'session:s1': {
                v: 1,
                selection: { start: 0, end: 12 },
                textLength: 12,
                updatedAt: 100,
            },
        });
    });

    it('clears session and new-session flow owners independently', () => {
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' }, { expanded: true }, 100);
        patchAgentInputLocalUiState(scopeA, { kind: 'newSession', flowId: 'f1' }, { expanded: true }, 100);

        clearAgentInputLocalUiStateForSession(scopeA, 's1');
        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 's1' })).toBeNull();
        expect(readAgentInputLocalUiState(scopeA, { kind: 'newSession', flowId: 'f1' })?.expanded).toBe(true);

        clearAgentInputLocalUiStateForNewSession(scopeA, 'f1');
        expect(readAgentInputLocalUiState(scopeA, { kind: 'newSession', flowId: 'f1' })).toBeNull();
    });

    it('garbage-collects stale local UI state and reloads from persisted cache after invalidation', () => {
        const now = 100 + AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS * 24 * 60 * 60 * 1000 + 1;
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 'old' }, { expanded: true }, 100);
        patchAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 'fresh' }, { expanded: true }, now);

        garbageCollectAgentInputLocalUiState(scopeA, { now });
        flushAgentInputLocalUiState(scopeA);
        invalidateAgentInputLocalUiStateCache(scopeA);

        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 'old' })).toBeNull();
        expect(readAgentInputLocalUiState(scopeA, { kind: 'session', sessionId: 'fresh' })?.expanded).toBe(true);
    });
});
