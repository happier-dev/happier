import { beforeEach, describe, expect, it, vi } from 'vitest';

import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { saveProfile } from '@/sync/domains/state/persistence';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { loadAccountProfile, saveAccountProfile } from '@/sync/domains/state/accountProfilePersistence';

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

import { createProfileDomain } from './profile';

type ScopedProfileDomain = ReturnType<typeof createProfileDomain> & Readonly<{
    profileScope: ServerAccountScope | null;
    activateProfileScope?: (scope: ServerAccountScope) => void;
    applyProfileForScope?: (scope: ServerAccountScope, profile: Profile) => void;
    clearProfileScope?: () => void;
}>;

function createTestStore(): { getState: () => ScopedProfileDomain } {
    let state = {} as ScopedProfileDomain;
    const set = (updater: ((state: ScopedProfileDomain) => Partial<ScopedProfileDomain> | ScopedProfileDomain) | Partial<ScopedProfileDomain>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const get = () => state;
    const domain = createProfileDomain<ScopedProfileDomain>({ set, get });
    state = { ...state, ...(domain as ScopedProfileDomain) };
    return { getState: () => state };
}

function requireScopedMethods(state: ScopedProfileDomain): asserts state is ScopedProfileDomain & Required<Pick<
    ScopedProfileDomain,
    'activateProfileScope' | 'applyProfileForScope' | 'clearProfileScope'
>> {
    expect(state.activateProfileScope, 'profile domain should expose activateProfileScope').toBeTypeOf('function');
    expect(state.applyProfileForScope, 'profile domain should expose applyProfileForScope').toBeTypeOf('function');
    expect(state.clearProfileScope, 'profile domain should expose clearProfileScope').toBeTypeOf('function');
}

describe('createProfileDomain scoped profiles', () => {
    const scopeA = { serverId: 'server-a', accountId: 'account-a' };
    const scopeB = { serverId: 'server-b', accountId: 'account-b' };

    beforeEach(() => {
        clearPersistence();
    });

    it('hydrates the active profile projection from the selected scope', () => {
        saveAccountProfile(scopeA, { ...profileDefaults, id: 'account-a', email: 'a@example.test' });
        saveAccountProfile(scopeB, { ...profileDefaults, id: 'account-b', email: 'b@example.test' });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);
        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toMatchObject({ id: 'account-a', email: 'a@example.test' });

        getState().activateProfileScope(scopeB);
        expect(getState().profileScope).toEqual(scopeB);
        expect(getState().profile).toMatchObject({ id: 'account-b', email: 'b@example.test' });
    });

    it('migrates the legacy unscoped profile into the first activated scope before replacing the active projection', () => {
        saveProfile({ ...profileDefaults, id: 'legacy-account', email: 'legacy@example.test' });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);

        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toMatchObject({ id: 'legacy-account', email: 'legacy@example.test' });
        expect(loadAccountProfile(scopeA)).toMatchObject({ id: 'legacy-account', email: 'legacy@example.test' });
    });

    it('does not let stale different-scope profile updates mutate the active projection', () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);
        getState().applyProfileForScope(scopeB, { ...profileDefaults, id: 'account-b', email: 'b@example.test' });

        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toEqual({ ...profileDefaults });
        expect(loadAccountProfile(scopeB)).toMatchObject({ id: 'account-b', email: 'b@example.test' });
    });
});
