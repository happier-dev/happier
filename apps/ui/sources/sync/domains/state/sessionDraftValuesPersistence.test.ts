import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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

import { clearPersistence } from './persistence';
import {
    agentInputLocalUiStateStorageKey,
    scopedSessionLocalStateKey,
    sessionDraftValuesStorageKey,
} from './sessionLocalStateKeys';
import {
    deleteRawSessionDraftValues,
    loadRawSessionDraftValues,
    saveRawSessionDraftValues,
} from './sessionDraftValuesPersistence';
import {
    deleteRawAgentInputLocalUiState,
    loadRawAgentInputLocalUiState,
    saveRawAgentInputLocalUiState,
} from './agentInputLocalUiStatePersistence';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

describe('session local state key helpers', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('scopes session-local keys by server account without changing legacy unscoped keys', () => {
        expect(scopedSessionLocalStateKey('session-drafts')).toBe('session-drafts');
        expect(scopedSessionLocalStateKey('session-drafts', scopeA)).toBe('session-drafts:scope:v2:8:server-a9:account-a');
        expect(scopedSessionLocalStateKey('session-drafts', scopeB)).toBe('session-drafts:scope:v2:8:server-a9:account-b');
    });

    it('uses dedicated scoped keys for semantic draft values and local UI state', () => {
        expect(sessionDraftValuesStorageKey(scopeA)).toBe('session-draft-values-v1:scope:v2:8:server-a9:account-a');
        expect(agentInputLocalUiStateStorageKey(scopeA)).toBe('agent-input-local-ui-state-v1:scope:v2:8:server-a9:account-a');
    });

    it('roundtrips raw semantic draft values without leaking across account scopes', () => {
        saveRawSessionDraftValues({ 'session-1': { 'routing.recipient': { v: 1, updatedAt: 100, value: null } } }, scopeA);

        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'routing.recipient': { v: 1, updatedAt: 100, value: null },
            },
        });
        expect(loadRawSessionDraftValues(scopeB)).toEqual({});
        expect(loadRawSessionDraftValues()).toEqual({});
    });

    it('roundtrips raw local UI state without leaking across account scopes', () => {
        saveRawAgentInputLocalUiState({ 'session:session-1': { v: 1, expanded: true, updatedAt: 100 } }, scopeA);

        expect(loadRawAgentInputLocalUiState(scopeA)).toEqual({
            'session:session-1': { v: 1, expanded: true, updatedAt: 100 },
        });
        expect(loadRawAgentInputLocalUiState(scopeB)).toEqual({});
        expect(loadRawAgentInputLocalUiState()).toEqual({});
    });

    it('deletes each new raw store independently', () => {
        saveRawSessionDraftValues({ 'session-1': { 'routing.recipient': { v: 1, updatedAt: 100, value: null } } }, scopeA);
        saveRawAgentInputLocalUiState({ 'session:session-1': { v: 1, expanded: true, updatedAt: 100 } }, scopeA);

        deleteRawSessionDraftValues(scopeA);
        expect(loadRawSessionDraftValues(scopeA)).toEqual({});
        expect(loadRawAgentInputLocalUiState(scopeA)).toEqual({
            'session:session-1': { v: 1, expanded: true, updatedAt: 100 },
        });

        deleteRawAgentInputLocalUiState(scopeA);
        expect(loadRawAgentInputLocalUiState(scopeA)).toEqual({});
    });
});
