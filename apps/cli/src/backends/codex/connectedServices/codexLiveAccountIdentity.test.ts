import { describe, expect, it, vi } from 'vitest';

import { readCodexLiveAccountIdentityFromClient } from './codexLiveAccountIdentity';

describe('readCodexLiveAccountIdentityFromClient', () => {
  it('forwards lifecycle-owned request options for recovery identity reads', async () => {
    const request = vi.fn(async () => ({
      account: { id: 'acct_runtime', email: 'runtime@example.test' },
    }));

    await expect(readCodexLiveAccountIdentityFromClient(
      { request },
      { timeoutMs: null },
    )).resolves.toEqual({
      activeAccountId: 'acct_runtime',
      accountLabel: 'runtime@example.test',
    });

    expect(request).toHaveBeenCalledWith('account/read', {}, { timeoutMs: null });
  });
});
