import { describe, expect, it } from 'vitest';

type AccountSettingsScope = Readonly<{
    serverId: string;
    accountId: string;
}>;

type AccountSettingsScopeModule = Readonly<{
    createAccountSettingsScope: (serverId: unknown, accountId: unknown) => AccountSettingsScope | null;
    areAccountSettingsScopesEqual: (a: AccountSettingsScope | null, b: AccountSettingsScope | null) => boolean;
    accountSettingsScopeKeySuffix: (scope: AccountSettingsScope) => string;
}>;

async function loadAccountSettingsScopeModule(): Promise<AccountSettingsScopeModule | null> {
    const loaded: unknown = await import('./accountSettingsScope').catch(() => null);
    if (!loaded || typeof loaded !== 'object') return null;
    return loaded as AccountSettingsScopeModule;
}

describe('accountSettingsScope', () => {
    it('creates a trimmed server/account settings scope', async () => {
        const mod = await loadAccountSettingsScopeModule();
        expect(mod, 'account settings scope module should exist').not.toBeNull();
        if (!mod) return;

        expect(mod.createAccountSettingsScope(' server-a ', ' account-a ')).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
        });
    });

    it('rejects missing server or account identifiers', async () => {
        const mod = await loadAccountSettingsScopeModule();
        expect(mod, 'account settings scope module should exist').not.toBeNull();
        if (!mod) return;

        expect(mod.createAccountSettingsScope('', 'account-a')).toBeNull();
        expect(mod.createAccountSettingsScope('server-a', '   ')).toBeNull();
        expect(mod.createAccountSettingsScope(null, 'account-a')).toBeNull();
        expect(mod.createAccountSettingsScope('server-a', undefined)).toBeNull();
    });

    it('compares scopes by normalized server and account identifiers', async () => {
        const mod = await loadAccountSettingsScopeModule();
        expect(mod, 'account settings scope module should exist').not.toBeNull();
        if (!mod) return;

        const scope = mod.createAccountSettingsScope('server-a', 'account-a');
        expect(mod.areAccountSettingsScopesEqual(scope, { serverId: 'server-a', accountId: 'account-a' })).toBe(true);
        expect(mod.areAccountSettingsScopesEqual(scope, { serverId: 'server-b', accountId: 'account-a' })).toBe(false);
        expect(mod.areAccountSettingsScopesEqual(scope, { serverId: 'server-a', accountId: 'account-b' })).toBe(false);
        expect(mod.areAccountSettingsScopesEqual(scope, null)).toBe(false);
    });

    it('builds collision-safe key suffixes', async () => {
        const mod = await loadAccountSettingsScopeModule();
        expect(mod, 'account settings scope module should exist').not.toBeNull();
        if (!mod) return;

        const first = mod.accountSettingsScopeKeySuffix({ serverId: 'ab', accountId: 'c' });
        const second = mod.accountSettingsScopeKeySuffix({ serverId: 'a', accountId: 'bc' });
        const delimiterLike = mod.accountSettingsScopeKeySuffix({ serverId: 'server:1', accountId: 'acct:2' });

        expect(first).not.toBe(second);
        expect(delimiterLike).not.toContain('server:1:acct:2');
    });
});
