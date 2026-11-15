import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import * as warmCachePersistence from '@/sync/domains/state/warmCachePersistence';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { StorageState } from '@/sync/store/types';

import { createSessionsDomain } from './sessions';

const SERVER_ID = 'srv_active';
const cleanup: Array<() => void> = [];

beforeAll(async () => { await warmCachePersistence.prepareWarmCacheStorage(); });
beforeEach(async () => {
    projectManager.clear();
    const profile = await upsertServerProfile({ serverUrl: `https://${SERVER_ID}.test` });
    await setServerProfileIdentityForUrl(`https://${SERVER_ID}.test`, SERVER_ID);
    await setActiveServerId(profile.id, { scope: 'device' });
});
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function createHarness() {
    const initial = storage.getInitialState();
    const store = createStore<StorageState>()((set, get) => ({
        ...initial,
        ...createSessionsDomain<StorageState>({ set, get }),
        machines: {}, machineDisplayById: {}, sessionMessages: {}, sessionMessagesHistoryStartLoaded: {},
        profile: { ...initial.profile, id: 'account_a' },
    }));
    const domain = store.getState();
    cleanup.push(() => domain.clearSessionLocalStateScope());
    return { get: store.getState, set: store.setState, domain };
}

function session(id: string, index: number, patch: Partial<Parameters<typeof createSessionFixture>[0]> = {}) {
    return createSessionFixture({
        id, serverId: getActiveServerSnapshot().serverId, seq: 1, createdAt: index + 1, updatedAt: index + 1,
        meaningfulActivityAt: index + 1, pendingCount: 0, pendingVersion: 1, ...patch,
    });
}

/** Counts element reads of a store array (membership, index), the driver of every per-Home row scan. */
function countingArray<T>(values: readonly T[], counter: { reads: number }): readonly T[] {
    return new Proxy(values as T[], {
        get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads += 1;
            return Reflect.get(target, key, receiver);
        },
    });
}

/**
 * One non-structural Session apply (a pending-count change) with L loaded ordinary rows: how many
 * membership and index entries the store reads. The index must stay the same object.
 */
function readEntriesPerSingleSessionApply(loadedRows: number): number {
    const { get, set, domain } = createHarness();
    const sessions = Array.from({ length: loadedRows }, (_, index) => session(`s-${index}`, index));
    domain.applySessions(sessions);
    domain.applyServerScopedSessionListRows(SERVER_ID, sessions.map(entry => buildSessionListRenderableFromSession(entry)),
        { source: 'ordinary', mode: 'replace' });

    const counter = { reads: 0 };
    const state = get();
    set({
        ordinarySessionListMembershipByServerId: { ...state.ordinarySessionListMembershipByServerId,
            [SERVER_ID]: countingArray(state.ordinarySessionListMembershipByServerId[SERVER_ID] ?? [], counter) },
        sessionListIndexByServerId: { ...state.sessionListIndexByServerId,
            [SERVER_ID]: countingArray(state.sessionListIndexByServerId[SERVER_ID] ?? [], counter) as never },
    });
    // The first publication after the arrays were replaced proves the projection once.
    domain.applySessions([session('s-1', 1, { pendingCount: 1, pendingVersion: 2 })]);
    const indexBefore = get().sessionListIndexByServerId[SERVER_ID];

    counter.reads = 0;
    domain.applySessions([session('s-2', 2, { pendingCount: 3, pendingVersion: 2 })]);
    const reads = counter.reads;

    expect(get().sessionListIndexByServerId[SERVER_ID]).toBe(indexBefore);
    expect(get().sessionListRowsByServerId[SERVER_ID]?.['s-2']?.pendingCount).toBe(3);
    return reads;
}

describe('sessions domain: single-Session apply cost', () => {
    it('reads a constant number of membership and index entries as loaded rows grow', () => {
        const small = readEntriesPerSingleSessionApply(100);
        const large = readEntriesPerSingleSessionApply(2_000);
        expect({ small, large }).toEqual({ small, large: small });
        expect(small).toBeLessThan(10);
    });
});

