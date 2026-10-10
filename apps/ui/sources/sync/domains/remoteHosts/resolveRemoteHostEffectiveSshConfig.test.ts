import { describe, expect, it, vi } from 'vitest';

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
    it('resolves referenced password material and refuses a retired Account instead of executing with an empty password', async () => {
        const remoteHost = { ...createHost(), ssh: { target: 'root@example.test', authMode: 'password' as const,
            passwordSecretRef: 'happier:shared-secret:v1:ssh-password' } };
        let current = true;
        const readSavedSecretValue = async () => current
            ? { ok: true as const, value: 'private-password' }
            : { ok: false as const, reason: 'changed' as const };
        const params = { remoteHost, localOverrides: null, secretMaterialAllowed: true, readSavedSecretValue };
        await expect(resolveRemoteHostEffectiveSshConfig(params)).resolves.toMatchObject({ ok: true, value: { password: 'private-password' } });
        current = false;
        await expect(resolveRemoteHostEffectiveSshConfig(params)).resolves.toMatchObject({ ok: false,
            error: { code: 'saved_secret_changed' } });
    });

    it('prefers local identityFilePath override over stored key material', async () => {
        const remoteHost = {
            ...createHost(),
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile' as const,
                identityPrivateKeySecretRef: 'happier:shared-secret:v1:ssh-key',
            },
        };

        const readSavedSecretValue = vi.fn(async () => ({ ok: true as const, value: 'DECRYPTED_KEY' }));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: { identityFilePath: '/Users/me/.ssh/id_ed25519' },
            secretMaterialAllowed: true,
            readSavedSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.identityFilePath).toBe('/Users/me/.ssh/id_ed25519');
            expect(result.value.identityPrivateKey).toBe('');
        }
        expect(readSavedSecretValue).not.toHaveBeenCalled();
    });

    it('uses stored key material when no local identityFilePath override exists', async () => {
        const remoteHost = {
            ...createHost(),
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile' as const,
                identityPrivateKeySecretRef: 'happier:shared-secret:v1:ssh-key',
            },
        };

        const readSavedSecretValue = vi.fn(async () => ({ ok: true as const, value: 'DECRYPTED_KEY' }));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: true,
            readSavedSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.identityFilePath).toBe('');
            expect(result.value.identityPrivateKey).toBe('DECRYPTED_KEY');
        }
        expect(readSavedSecretValue).toHaveBeenCalledWith('happier:shared-secret:v1:ssh-key');
    });

    it('fails closed for stored key material when secret material is not allowed', async () => {
        const remoteHost = {
            ...createHost(),
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'keyfile' as const,
                identityPrivateKeySecretRef: 'happier:shared-secret:v1:ssh-key',
            },
        };

        const readSavedSecretValue = vi.fn(async () => ({ ok: true as const, value: 'DECRYPTED_KEY' }));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: false,
            readSavedSecretValue,
        });

        expect(result.ok).toBe(false);
        expect(readSavedSecretValue).not.toHaveBeenCalled();
    });

    it('loads the password reference only when password auth is selected and secret material is allowed', async () => {
        const remoteHost = {
            ...createHost(),
            ssh: {
                target: 'root@example.test',
                port: 22,
                authMode: 'password' as const,
                passwordSecretRef: 'happier:shared-secret:v1:ssh-password',
            },
        };

        const readSavedSecretValue = vi.fn(async () => ({ ok: true as const, value: 'DECRYPTED_PASSWORD' }));

        const result = await resolveRemoteHostEffectiveSshConfig({
            remoteHost,
            localOverrides: null,
            secretMaterialAllowed: true,
            readSavedSecretValue,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.password).toBe('DECRYPTED_PASSWORD');
        }
        expect(readSavedSecretValue).toHaveBeenCalledWith('happier:shared-secret:v1:ssh-password');
    });

    it('refuses unavailable password references instead of silently relying on native prompting', async () => {
        const remoteHost = { ...createHost(), ssh: { target: 'root@example.test', authMode: 'password' as const,
            passwordSecretRef: 'happier:shared-secret:v1:ssh-password' } };
        await expect(resolveRemoteHostEffectiveSshConfig({ remoteHost, localOverrides: null, secretMaterialAllowed: true,
            readSavedSecretValue: async () => ({ ok: false, reason: 'unavailable' }) })).resolves.toMatchObject({
                ok: false, error: { code: 'saved_secret_unavailable' },
            });
    });
});
