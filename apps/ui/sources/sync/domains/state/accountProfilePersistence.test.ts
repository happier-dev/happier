import { beforeEach, describe, expect, it, vi } from 'vitest';

import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import { purchasesDefaults, type Purchases } from '@/sync/domains/purchases/purchases';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type AccountProfilePersistenceModule = Readonly<{
    loadAccountProfile: (scope: ServerAccountScope) => Profile;
    saveAccountProfile: (scope: ServerAccountScope, profile: Profile) => void;
    prepareAccountProfileScopeForActivation: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
    loadAccountPurchases: (scope: ServerAccountScope) => Purchases;
    saveAccountPurchases: (scope: ServerAccountScope, purchases: Purchases) => void;
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

    it('persists purchases separately for each server/account scope', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountPurchases(scopeA, { ...purchasesDefaults, entitlements: { pro: true } });
        mod.saveAccountPurchases(sameAccountDifferentServer, { ...purchasesDefaults, entitlements: { voice: true } });

        expect(mod.loadAccountPurchases(scopeA)).toMatchObject({ entitlements: { pro: true } });
        expect(mod.loadAccountPurchases(sameAccountDifferentServer)).toMatchObject({ entitlements: { voice: true } });
        expect(mod.loadAccountPurchases(sameServerDifferentAccount)).toEqual({ ...purchasesDefaults });
    });

    it('migrates legacy profile and purchases into the first activated scope before deleting legacy keys', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        store.set('profile', JSON.stringify({ ...profileDefaults, id: 'legacy-account', username: 'legacy-user' }));
        store.set('purchases', JSON.stringify({ ...purchasesDefaults, entitlements: { pro: true } }));

        mod.prepareAccountProfileScopeForActivation(scopeA);

        expect(mod.loadAccountProfile(scopeA)).toMatchObject({ id: 'legacy-account', username: 'legacy-user' });
        expect(mod.loadAccountPurchases(scopeA)).toMatchObject({ entitlements: { pro: true } });
        expect(store.has('profile')).toBe(false);
        expect(store.has('purchases')).toBe(false);
    });

    it('keeps existing scoped profile and purchases when activation sees legacy unscoped cache', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountProfile(scopeA, { ...profileDefaults, id: 'scoped-account', username: 'scoped-user' });
        mod.saveAccountPurchases(scopeA, { ...purchasesDefaults, entitlements: { voice: true } });
        store.set('profile', JSON.stringify({ ...profileDefaults, id: 'legacy-account', username: 'legacy-user' }));
        store.set('purchases', JSON.stringify({ ...purchasesDefaults, entitlements: { pro: true } }));

        mod.prepareAccountProfileScopeForActivation(scopeA);

        expect(mod.loadAccountProfile(scopeA)).toMatchObject({ id: 'scoped-account', username: 'scoped-user' });
        expect(mod.loadAccountPurchases(scopeA)).toMatchObject({ entitlements: { voice: true } });
        expect(store.has('profile')).toBe(false);
        expect(store.has('purchases')).toBe(false);
    });

    it('uses host-derived legacy profile and purchases as identity-scope fallback without replacing existing identity cache', async () => {
        const mod = await loadAccountProfilePersistenceModule();
        expect(mod, 'account profile persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountProfile(legacyScope, { ...profileDefaults, id: 'legacy-account', username: 'legacy-user' });
        mod.saveAccountPurchases(legacyScope, { ...purchasesDefaults, entitlements: { pro: true } });

        mod.prepareAccountProfileScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadAccountProfile(identityScope)).toMatchObject({ id: 'legacy-account', username: 'legacy-user' });
        expect(mod.loadAccountPurchases(identityScope)).toMatchObject({ entitlements: { pro: true } });

        mod.saveAccountProfile(identityScope, { ...profileDefaults, id: 'identity-account', username: 'identity-user' });
        mod.saveAccountPurchases(identityScope, { ...purchasesDefaults, entitlements: { voice: true } });
        mod.prepareAccountProfileScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadAccountProfile(identityScope)).toMatchObject({ id: 'identity-account', username: 'identity-user' });
        expect(mod.loadAccountPurchases(identityScope)).toMatchObject({ entitlements: { voice: true } });
    });
});
