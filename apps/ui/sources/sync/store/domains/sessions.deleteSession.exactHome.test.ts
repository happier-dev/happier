import { beforeEach, describe, expect, it, vi } from 'vitest';

// Boundary mock (platform storage): the sessions domain persists drafts/permission
// modes through react-native-mmkv, which has no JS implementation in vitest.
const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }
        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }
        delete(key: string) {
            mmkvStore.delete(key);
        }
        clearAll() {
            mmkvStore.clear();
        }
    }
    return { MMKV };
});

import { createSessionsDomain, isSessionRetiredForServer } from './sessions';
import { clearPersistence } from '@/sync/domains/state/persistence';

const SESSION_ID = 's_shared';
const HOME_A = 'home-a';
const HOME_B = 'home-b';

function createRow(serverId: string) {
    return {
        id: SESSION_ID,
        serverId,
        seq: 1,
        active: true,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 0,
        metadata: { name: `row on ${serverId}` },
    } as any;
}

function createHarness(options?: Readonly<{ includeCarrierRow?: boolean }>) {
    const includeCarrierRow = options?.includeCarrierRow !== false;
    let state: any = {
        sessions: {
            [SESSION_ID]: { id: SESSION_ID, serverId: HOME_A, metadata: { name: 'carrier' } },
        },
        sessionListIndexByServerId: {
            [HOME_A]: [{ type: 'session', sessionId: SESSION_ID }],
            [HOME_B]: [{ type: 'session', sessionId: SESSION_ID }],
        },
        sessionListRowsByServerId: {
            [HOME_A]: includeCarrierRow ? { [SESSION_ID]: createRow(HOME_A) } : {},
            [HOME_B]: { [SESSION_ID]: createRow(HOME_B) },
        },
        ordinarySessionListMembershipByServerId: {
            [HOME_A]: includeCarrierRow ? [SESSION_ID] : [],
            [HOME_B]: [SESSION_ID],
        },
        archivedSessionListMembershipByServerId: {},
        concurrentSessionListCacheByServerId: {},
        deletedSessionIds: {},
        sessionScmStatus: { [SESSION_ID]: { branch: 'main' } },
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        isDataReady: true,
        machines: {},
        machineDisplayById: {},
        sessionMessages: { [SESSION_ID]: [{ id: 'm1' }] },
        sessionMessageToolVersion: 0,
        sessionMessagesHistoryStartLoaded: {},
        settings: {},
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    // The domain publishes empty defaults as well as its actions. Keep this test's
    // already-populated per-Home fixture authoritative while installing those actions.
    state = { ...domain, ...state };
    return { get, domain };
}

describe('sessions domain: deleteSession addresses one Home', () => {
    beforeEach(() => {
        clearPersistence();
        mmkvStore.clear();
    });

    it('removes only the addressed Home row and keeps the other Home row plus the shared carrier', () => {
        const { get, domain } = createHarness();

        domain.deleteSession(SESSION_ID, HOME_B);

        const state = get();
        expect(state.sessionListRowsByServerId[HOME_B][SESSION_ID]).toBeUndefined();
        expect(state.ordinarySessionListMembershipByServerId[HOME_B]).toEqual([]);
        expect(state.sessionListRowsByServerId[HOME_A][SESSION_ID]).toBeDefined();
        expect(state.ordinarySessionListMembershipByServerId[HOME_A]).toEqual([SESSION_ID]);
        expect(state.sessionListIndexByServerId[HOME_A]).toEqual([{ type: 'session', sessionId: SESSION_ID }]);
        expect(state.sessionListIndexByServerId[HOME_B]).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: SESSION_ID })]),
        );
        // The shared per-id carrier belongs to Home A, so Home B's deletion must not erase it.
        expect(state.sessions[SESSION_ID]).toBeDefined();
        expect(state.sessionMessages[SESSION_ID]).toBeDefined();
        expect(state.sessionScmStatus[SESSION_ID]).toBeDefined();
        expect(state.deletedSessionIds[SESSION_ID]).toBeUndefined();
    });

    it('does not tombstone another Home carrier when its list row is not cached', () => {
        const { get, domain } = createHarness({ includeCarrierRow: false });

        domain.deleteSession(SESSION_ID, HOME_B);

        const state = get();
        expect(state.sessionListRowsByServerId[HOME_B][SESSION_ID]).toBeUndefined();
        expect(state.sessions[SESSION_ID]).toBeDefined();
        expect(state.sessionMessages[SESSION_ID]).toBeDefined();
        expect(state.deletedSessionIds[SESSION_ID]).toBeUndefined();
    });

    it('retires the shared carrier when the addressed Home owns it, leaving the other Home row', () => {
        const { get, domain } = createHarness();

        domain.deleteSession(SESSION_ID, HOME_A);

        const state = get();
        expect(state.sessionListRowsByServerId[HOME_A][SESSION_ID]).toBeUndefined();
        expect(state.sessionListRowsByServerId[HOME_B][SESSION_ID]).toBeDefined();
        expect(state.sessions[SESSION_ID]).toBeUndefined();
        expect(state.sessionMessages[SESSION_ID]).toBeUndefined();
        expect(state.sessionScmStatus[SESSION_ID]).toBeUndefined();
        // The tombstone records the Home that was retired, so the surviving Home B
        // carrier for the same id is not answered as deleted.
        expect(state.deletedSessionIds[SESSION_ID]).toBe(HOME_A);
        expect(isSessionRetiredForServer(state.deletedSessionIds, SESSION_ID, HOME_A)).toBe(true);
        expect(isSessionRetiredForServer(state.deletedSessionIds, SESSION_ID, HOME_B)).toBe(false);
        // A reader holding no Home at all stays at the unqualified boundary.
        expect(isSessionRetiredForServer(state.deletedSessionIds, SESSION_ID, null)).toBe(true);
    });

    it('keeps the unqualified whole-id teardown for a Home-agnostic deletion', () => {
        const { get, domain } = createHarness();

        domain.deleteSession(SESSION_ID);

        const state = get();
        expect(state.sessionListRowsByServerId[HOME_A][SESSION_ID]).toBeUndefined();
        expect(state.sessionListRowsByServerId[HOME_B][SESSION_ID]).toBeUndefined();
        expect(state.sessions[SESSION_ID]).toBeUndefined();
        expect(state.sessionMessages[SESSION_ID]).toBeUndefined();
        // No Home was addressed and every Home's row went, so the tombstone answers
        // for all of them.
        expect(state.deletedSessionIds[SESSION_ID]).toBe(true);
        expect(isSessionRetiredForServer(state.deletedSessionIds, SESSION_ID, HOME_B)).toBe(true);
    });
});
