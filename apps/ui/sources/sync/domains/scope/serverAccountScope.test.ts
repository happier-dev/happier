import { describe, expect, it } from 'vitest';

import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
} from './serverAccountScope';

describe('serverAccountScope', () => {
    it('creates a trimmed server/account scope', () => {
        expect(createServerAccountScope(' server-a ', ' account-a ')).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
        });
    });

    it('rejects missing server or account identifiers', () => {
        expect(createServerAccountScope('', 'account-a')).toBeNull();
        expect(createServerAccountScope('server-a', '   ')).toBeNull();
        expect(createServerAccountScope(null, 'account-a')).toBeNull();
        expect(createServerAccountScope('server-a', undefined)).toBeNull();
    });

    it('compares scopes by normalized server and account identifiers', () => {
        const scope = createServerAccountScope('server-a', 'account-a');

        expect(areServerAccountScopesEqual(scope, { serverId: 'server-a', accountId: 'account-a' })).toBe(true);
        expect(areServerAccountScopesEqual(scope, { serverId: 'server-b', accountId: 'account-a' })).toBe(false);
        expect(areServerAccountScopesEqual(scope, { serverId: 'server-a', accountId: 'account-b' })).toBe(false);
        expect(areServerAccountScopesEqual(scope, null)).toBe(false);
    });

    it('builds collision-safe key suffixes', () => {
        const first = serverAccountScopeKeySuffix({ serverId: 'ab', accountId: 'c' });
        const second = serverAccountScopeKeySuffix({ serverId: 'a', accountId: 'bc' });
        const delimiterLike = serverAccountScopeKeySuffix({ serverId: 'server:1', accountId: 'acct:2' });

        expect(first).not.toBe(second);
        expect(delimiterLike).not.toContain('server:1:acct:2');
    });
});
