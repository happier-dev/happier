import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const fetchAccountEncryptionModeSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

describe('useCredentialScopedAccountModeResolver', () => {
    afterEach(() => {
        fetchAccountEncryptionModeSpy.mockReset();
        standardCleanup();
    });

    it('retries after a transient fetch failure instead of caching the fallback mode', async () => {
        fetchAccountEncryptionModeSpy
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValueOnce({ mode: 'plain', updatedAt: 1 });

        const credentials = {
            token: 'token',
            secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
        };
        const { useCredentialScopedAccountModeResolver } = await import('./useCredentialScopedAccountModeResolver');
        const hook = await renderHook(() => useCredentialScopedAccountModeResolver({
            credentials,
            credentialScope: 'scope-a',
        }));

        await expect(hook.getCurrent()()).resolves.toBe('e2ee');
        await expect(hook.getCurrent()()).resolves.toBe('plain');
        expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(2);

        await hook.unmount();
    });
});
