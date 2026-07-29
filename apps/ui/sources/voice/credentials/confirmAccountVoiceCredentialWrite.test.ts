import { describe, expect, it, vi } from 'vitest';

import { confirmAccountVoiceCredentialWrite } from './confirmAccountVoiceCredentialWrite';

describe('confirmAccountVoiceCredentialWrite', () => {
  it('requires explicit confirmation before a cloud account credential is saved to a plain account', async () => {
    const confirm = vi.fn(async () => false);

    await expect(confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: true,
      resolveAccountMode: async () => 'plain',
      confirm,
    })).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledOnce();
  });

  it('skips confirmation for E2EE or credentials explicitly exempted from disclosure', async () => {
    const confirm = vi.fn(async () => true);

    await expect(confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: true,
      resolveAccountMode: async () => 'e2ee',
      confirm,
    })).resolves.toBe(true);
    await expect(confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: false,
      resolveAccountMode: async () => 'plain',
      confirm,
    })).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
  });
});
