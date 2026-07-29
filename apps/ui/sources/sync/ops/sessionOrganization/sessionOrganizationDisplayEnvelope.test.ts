import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createEncryptionFromAuthCredentials: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: mocks.createEncryptionFromAuthCredentials,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode,
}));

const credentials = { token: 'token-a', secret: 'secret-a' };
const machineKey = new Uint8Array(32).fill(7);

describe('session organization display envelopes', () => {
    beforeEach(() => {
        mocks.createEncryptionFromAuthCredentials.mockReset();
        mocks.createEncryptionFromAuthCredentials.mockResolvedValue({
            getContentPrivateKey: () => machineKey,
        });
        mocks.fetchAccountEncryptionMode.mockReset();
    });

    it('keeps display payloads plain for plain-storage accounts', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValueOnce({ mode: 'plain', updatedAt: 0 });
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');

        await expect(prepareSessionOrganizationDisplayEnvelope({
            credentials,
            value: { label: 'Project A' },
        })).resolves.toEqual({ t: 'plain', v: { label: 'Project A' } });
        expect(mocks.createEncryptionFromAuthCredentials).not.toHaveBeenCalled();
    });

    it('seals display payloads for e2ee accounts and opens them back to plain envelopes', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValueOnce({ mode: 'e2ee', updatedAt: 0 });
        const {
            openSessionOrganizationDisplayEnvelope,
            prepareSessionOrganizationDisplayEnvelope,
        } = await import('./sessionOrganizationDisplayEnvelope');

        const sealed = await prepareSessionOrganizationDisplayEnvelope({
            credentials,
            value: { label: 'Secret Project' },
        });

        expect(sealed.t).toBe('encrypted');
        expect(sealed).not.toHaveProperty('v');
        await expect(openSessionOrganizationDisplayEnvelope({
            credentials,
            envelope: sealed,
        })).resolves.toEqual({ t: 'plain', v: { label: 'Secret Project' } });
    });
});
