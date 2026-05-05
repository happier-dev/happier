import { describe, expect, it } from 'vitest';

import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
} from './serverAccountScope';

describe('serverAccountScope', () => {
    it('normalizes non-empty server and account ids', () => {
        expect(createServerAccountScope(' server-a ', ' account-a ')).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
        });
        expect(createServerAccountScope('', 'account-a')).toBeNull();
        expect(createServerAccountScope('server-a', '  ')).toBeNull();
    });

    it('compares complete server/account identity', () => {
        expect(areServerAccountScopesEqual(
            { serverId: 'server-a', accountId: 'account-a' },
            { serverId: 'server-a', accountId: 'account-a' },
        )).toBe(true);
        expect(areServerAccountScopesEqual(
            { serverId: 'server-a', accountId: 'account-a' },
            { serverId: 'server-b', accountId: 'account-a' },
        )).toBe(false);
    });

    it('encodes key suffixes without delimiter collisions', () => {
        expect(serverAccountScopeKeySuffix({ serverId: 'ab', accountId: 'c' }))
            .not.toBe(serverAccountScopeKeySuffix({ serverId: 'a', accountId: 'bc' }));
        expect(serverAccountScopeKeySuffix({ serverId: 'server:a', accountId: 'acct:b' }))
            .toBe('8:server:a6:acct:b');
    });
});
