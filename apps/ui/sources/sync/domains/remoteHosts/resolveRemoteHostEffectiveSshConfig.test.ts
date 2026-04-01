import { describe, expect, it, vi } from 'vitest';

import { SecretStringSchema } from '@/sync/encryption/secretSettings';

import type { RemoteHost } from './remoteHostModel';
import { resolveRemoteHostEffectiveSshConfig } from './resolveRemoteHostEffectiveSshConfig';

function createHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
    return {
        id: 'rh1',
        name: 'Test',
        ssh: {
            target: 'root@example.test',
            port: 22,
            authMode: 'agent',
        },
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        ...overrides,
    };
}

describe('resolveRemoteHostEffectiveSshConfig', () => {
    it('prefers local identityFilePath override over stored key material', async () => {
        const identityPrivateKeyEnc = SecretStringSchema.parse({ _isSecretValue: true, value: 'KEY' });
        const remoteHost = createHost({
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile',
                identityPrivateKeyEnc,
            },
        });

        const decryptSecretValue = vi.fn((input) => (input ? 'DECRYPTED_KEY' : null));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: { identityFilePath: '/Users/me/.ssh/id_ed25519' },
            secretMaterialAllowed: true,
            decryptSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.identityFilePath).toBe('/Users/me/.ssh/id_ed25519');
            expect(result.value.identityPrivateKey).toBe('');
        }
        expect(decryptSecretValue).not.toHaveBeenCalled();
    });

    it('uses stored key material when no local identityFilePath override exists', async () => {
        const identityPrivateKeyEnc = SecretStringSchema.parse({ _isSecretValue: true, value: 'KEY' });
        const remoteHost = createHost({
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile',
                identityPrivateKeyEnc,
            },
        });

        const decryptSecretValue = vi.fn((input) => (input ? 'DECRYPTED_KEY' : null));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: true,
            decryptSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.identityFilePath).toBe('');
            expect(result.value.identityPrivateKey).toBe('DECRYPTED_KEY');
        }
        expect(decryptSecretValue).toHaveBeenCalledTimes(1);
    });

    it('fails closed for stored key material when secret material is not allowed', async () => {
        const identityPrivateKeyEnc = SecretStringSchema.parse({ _isSecretValue: true, value: 'KEY' });
        const remoteHost = createHost({
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile',
                identityPrivateKeyEnc,
            },
        });

        const decryptSecretValue = vi.fn(() => 'DECRYPTED_KEY');

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: false,
            decryptSecretValue,
        });

        expect(result.ok).toBe(false);
        expect(decryptSecretValue).not.toHaveBeenCalled();
    });

    it('decrypts passwordEnc when password auth is selected and secret material is allowed', async () => {
        const passwordEnc = SecretStringSchema.parse({ _isSecretValue: true, value: 'PASSWORD' });
        const remoteHost = createHost({
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'password',
                passwordEnc,
            },
        });

        const decryptSecretValue = vi.fn((input) => (input ? 'DECRYPTED_PASSWORD' : null));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: true,
            decryptSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.password).toBe('DECRYPTED_PASSWORD');
        }
        expect(decryptSecretValue).toHaveBeenCalledTimes(1);
    });
});
