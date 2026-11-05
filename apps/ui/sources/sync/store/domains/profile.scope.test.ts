import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { loadAccountProfile, saveAccountProfile } from '@/sync/domains/state/accountProfilePersistence';
import { saveProfile } from '@/sync/domains/state/profilePersistence';

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
    activateProfileScope?: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
    applyProfileForScope?: (scope: ServerAccountScope, profile: Profile) => void;
    clearProfileScope?: () => void;
}>;

function createTestStore() {
    return createStore<ScopedProfileDomain>((set, get) => createProfileDomain<ScopedProfileDomain>({ set, get }));
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

    it('suppresses equal profile echoes and keeps unchanged fields on a real update', () => {
        const api = createTestStore();
        const profile = { ...structuredClone(profileDefaults), id: 'account-a', name: 'Account A' };
        api.getState().applyProfile(profile);
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        api.getState().applyProfile(structuredClone(profile));
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.getState().applyProfile({ ...structuredClone(profile), timestamp: 1 });
        expect(api.getState().profile.timestamp).toBe(1);
        expect(api.getState().profile.connectedAccountsV4).toBe(previous.profile.connectedAccountsV4);
        expect(api.getState().profile.linkedProviders).toBe(previous.profile.linkedProviders);
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('retains unchanged accounts and nested identity when another account health changes', () => {
        const api = createTestStore();
        const accounts = ['work', 'personal'].map(accountId => QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId },
            status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced',
            credentialRevision: null, configurationReady: true, configurationRevision: null,
        }));
        api.getState().applyProfile({ ...structuredClone(profileDefaults), id: 'account-a', connectedAccountsV4: accounts });
        const previous = api.getState().profile;
        const next = structuredClone(previous);
        next.connectedAccountsV4[1].status = 'needs_reauth';
        api.getState().applyProfile(next);
        const current = api.getState().profile;
        expect(current.connectedAccountsV4[0]).toBe(previous.connectedAccountsV4[0]);
        expect(current.connectedAccountsV4[1]).not.toBe(previous.connectedAccountsV4[1]);
        expect(current.connectedAccountsV4[1].ref).toBe(previous.connectedAccountsV4[1].ref);
        expect(current.connectedAccountsV4[1].status).toBe('needs_reauth');
    });

    it('suppresses repeated activation, scoped echoes and clearing but publishes scope changes', () => {
        const api = createTestStore();
        api.getState().activateProfileScope(scopeA);
        api.getState().applyProfileForScope(scopeA, { ...profileDefaults, id: 'account-a' });
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        api.getState().applyProfileForScope({ ...scopeA }, structuredClone(previous.profile));
        api.getState().activateProfileScope({ ...scopeA });
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        saveAccountProfile(scopeB, structuredClone(previous.profile));
        api.getState().activateProfileScope(scopeB);
        expect(api.getState().profileScope).toEqual(scopeB);
        expect(notified).toHaveBeenCalledTimes(1);

        api.getState().clearProfileScope();
        const cleared = api.getState();
        api.getState().clearProfileScope();
        expect(api.getState()).toBe(cleared);
        expect(notified).toHaveBeenCalledTimes(2);
    });

    it('hydrates the active profile projection from the selected scope', () => {
        saveAccountProfile(scopeA, { ...profileDefaults, id: 'account-a', name: 'Account A' });
        saveAccountProfile(scopeB, { ...profileDefaults, id: 'account-b', name: 'Account B' });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);
        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toMatchObject({ id: 'account-a', name: 'Account A' });

        getState().activateProfileScope(scopeB);
        expect(getState().profileScope).toEqual(scopeB);
        expect(getState().profile).toMatchObject({ id: 'account-b', name: 'Account B' });
    });

    it('migrates the legacy unscoped profile into the first activated scope before replacing the active projection', () => {
        saveProfile({ ...profileDefaults, id: 'legacy-account', name: 'Legacy Account' });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);

        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toMatchObject({ id: 'legacy-account', name: 'Legacy Account' });
        expect(loadAccountProfile(scopeA)).toMatchObject({ id: 'legacy-account', name: 'Legacy Account' });
    });

    it('does not let stale different-scope profile updates mutate the active projection', () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(scopeA);
        getState().applyProfileForScope(scopeB, { ...profileDefaults, id: 'account-b', name: 'Account B' });

        expect(getState().profileScope).toEqual(scopeA);
        expect(getState().profile).toEqual({ ...profileDefaults });
        expect(loadAccountProfile(scopeB)).toMatchObject({ id: 'account-b', name: 'Account B' });
    });

    it('hydrates from a host-derived legacy scope when activating an identity-keyed profile scope', () => {
        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        saveAccountProfile(legacyScope, { ...profileDefaults, id: 'legacy-account', name: 'Legacy Account' });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateProfileScope(identityScope, [legacyScope]);

        expect(getState().profileScope).toEqual(identityScope);
        expect(getState().profile).toMatchObject({ id: 'legacy-account', name: 'Legacy Account' });
        expect(loadAccountProfile(identityScope)).toMatchObject({ id: 'legacy-account', name: 'Legacy Account' });
    });
});
