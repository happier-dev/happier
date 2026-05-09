import { describe, expect, it } from 'vitest';

import { accountSettingsScopeKeySuffix } from './accountSettingsScopeKeySuffix';

describe('accountSettingsScopeKeySuffix', () => {
  it('encodes each scope part with a length prefix to avoid collisions', () => {
    const first = accountSettingsScopeKeySuffix({ serverId: 'ab', accountId: 'c' });
    const second = accountSettingsScopeKeySuffix({ serverId: 'a', accountId: 'bc' });

    expect(first).toBe('2:ab1:c');
    expect(second).toBe('1:a2:bc');
    expect(first).not.toBe(second);
  });

  it('preserves delimiter-like characters inside scope values', () => {
    const suffix = accountSettingsScopeKeySuffix({ serverId: 'server:1', accountId: 'acct:2' });
    expect(suffix).toBe('8:server:16:acct:2');
  });
});
