import { beforeEach, describe, expect, it, vi } from 'vitest';

import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type AccountProfilePersistenceModule = Readonly<{
    loadAccountProfile: (scope: ServerAccountScope) => Profile;
    saveAccountProfile: (scope: ServerAccountScope, profile: Profile) => void;
    prepareAccountProfileScopeForActivation: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
}>;

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

async function loadAccountProfilePersistenceModule(): Promise<AccountProfilePersistenceModule | null> {
    const loaded: unknown = await import('./accountProfilePersistence').catch(() => null);
    if (!loaded || typeof loaded !== 'object') return null;
    return loaded as AccountProfilePersistenceModule;
}

describe('accountProfilePersistence', () => {
    const scopeA = { serverId: 'server-a', accountId: 'account-a' };
    const sameAccountDifferentServer = { serverId: 'server-b', accountId: 'account-a' };
    const sameServerDifferentAccount = { serverId: 'server-a', accountId: 'account-b' };

    beforeEach(() => {
        store.clear();
    });

    it('persists profiles separately for each server/account scope', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountProfile(scopeA, { ...profileDefaults, id: 'account-a', email: 'a@example.test' });
        mod.saveAccountProfile(sameAccountDifferentServer, { ...profileDefaults, id: 'account-a-remote', email: 'remote@example.test' });
        mod.saveAccountProfile(sameServerDifferentAccount, { ...profileDefaults, id: 'account-b', email: 'b@example.test' });

        expect(mod.loadAccountProfile(scopeA)).toMatchObject({ id: 'account-a', email: 'a@example.test' });
        expect(mod.loadAccountProfile(sameAccountDifferentServer)).toMatchObject({ id: 'account-a-remote', email: 'remote@example.test' });
        expect(mod.loadAccountProfile(sameServerDifferentAccount)).toMatchObject({ id: 'account-b', email: 'b@example.test' });
    });

    it('migrates the legacy profile into the first activated scope before deleting the legacy key', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        store.set('profile', JSON.stringify({ ...profileDefaults, id: 'legacy-account', username: 'legacy-user' }));

        mod.prepareAccountProfileScopeForActivation(scopeA);

        expect(mod.loadAccountProfile(scopeA)).toMatchObject({ id: 'legacy-account', username: 'legacy-user' });
        expect(store.has('profile')).toBe(false);
    });

    it('keeps the existing scoped profile when activation sees a legacy unscoped cache', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountProfile(scopeA, { ...profileDefaults, id: 'scoped-account', username: 'scoped-user' });
        store.set('profile', JSON.stringify({ ...profileDefaults, id: 'legacy-account', username: 'legacy-user' }));

        mod.prepareAccountProfileScopeForActivation(scopeA);

        expect(mod.loadAccountProfile(scopeA)).toMatchObject({ id: 'scoped-account', username: 'scoped-user' });
        expect(store.has('profile')).toBe(false);
    });

    it('uses the host-derived legacy profile as identity-scope fallback without replacing existing identity cache', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountProfile(legacyScope, { ...profileDefaults, id: 'legacy-account', username: 'legacy-user' });

        mod.prepareAccountProfileScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadAccountProfile(identityScope)).toMatchObject({ id: 'legacy-account', username: 'legacy-user' });

        mod.saveAccountProfile(identityScope, { ...profileDefaults, id: 'identity-account', username: 'identity-user' });
        mod.prepareAccountProfileScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadAccountProfile(identityScope)).toMatchObject({ id: 'identity-account', username: 'identity-user' });
    });
});
