import { describe, expect, it } from 'vitest';

import {
    accountSettingsScopeKeySuffix,
    areAccountSettingsScopesEqual,
    createAccountSettingsScope,
} from './accountSettingsScope';

describe('accountSettingsScope', () => {
    it('creates a trimmed server/account settings scope', () => {
        expect(createAccountSettingsScope(' server-a ', ' account-a ')).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
        });
    });

    it('rejects missing server or account identifiers', () => {
        expect(createAccountSettingsScope('', 'account-a')).toBeNull();
        expect(createAccountSettingsScope('server-a', '   ')).toBeNull();
        expect(createAccountSettingsScope(null, 'account-a')).toBeNull();
        expect(createAccountSettingsScope('server-a', undefined)).toBeNull();
    });

    it('compares scopes by normalized server and account identifiers', () => {
        const scope = createAccountSettingsScope('server-a', 'account-a');
        expect(areAccountSettingsScopesEqual(scope, { serverId: 'server-a', accountId: 'account-a' })).toBe(true);
        expect(areAccountSettingsScopesEqual(scope, { serverId: 'server-b', accountId: 'account-a' })).toBe(false);
        expect(areAccountSettingsScopesEqual(scope, { serverId: 'server-a', accountId: 'account-b' })).toBe(false);
        expect(areAccountSettingsScopesEqual(scope, null)).toBe(false);
    });

    it('builds collision-safe key suffixes', () => {
        const first = accountSettingsScopeKeySuffix({ serverId: 'ab', accountId: 'c' });
        const second = accountSettingsScopeKeySuffix({ serverId: 'a', accountId: 'bc' });
        const delimiterLike = accountSettingsScopeKeySuffix({ serverId: 'server:1', accountId: 'acct:2' });

        expect(first).not.toBe(second);
        expect(delimiterLike).not.toContain('server:1:acct:2');
    });
});
