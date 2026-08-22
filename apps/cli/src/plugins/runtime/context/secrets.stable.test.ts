import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
    createDaemonPluginSecretCustodyRouter,
    createDeclaredPluginSecretsService,
    createPluginSecretCustodyRouter,
} from './secrets';

async function createFixture(params?: Readonly<{
    isGenerationCurrent?: () => boolean;
}>) {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-stable-secrets-'));
    const registerRawForRedaction = vi.fn<(value: string) => void>();
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const daemonCustody = createDaemonPluginSecretCustodyRouter({
        paths,
        resolveDeviceLocalSecretStorage: async () => ({
            deriveSecretKey: () => new Uint8Array(32).fill(7),
        }),
    });
    const service = createDeclaredPluginSecretsService({
        pluginId: 'acme.notifications',
        declarations: [{ id: 'webhook-token', custody: 'daemon' }],
        resolveCustody: createPluginSecretCustodyRouter({
            daemon: daemonCustody.resolve,
        }).resolve,
        signal: new AbortController().signal,
        isGenerationCurrent: params?.isGenerationCurrent ?? (() => true),
        registerRawForRedaction,
    });
    return { happyHomeDir, service, registerRawForRedaction };
}

describe('stable scoped plugin secrets service', () => {
    it('uses the encrypted owner for configured/missing state, opaque CAS revisions, and redaction registration', async () => {
        const { happyHomeDir, service, registerRawForRedaction } = await createFixture();

        const missing = await service.status('webhook-token');
        expect(missing).toMatchObject({ state: 'missing', revision: expect.any(String) });
        await expect(service.get('webhook-token')).rejects.toMatchObject({ code: 'plugin_secret_missing' });

        const configured = await service.set('webhook-token', 'super-secret', {
            expectedRevision: missing.revision,
        });
        expect(configured.revision).not.toBe(missing.revision);
        expect(await service.status('webhook-token')).toEqual({
            state: 'configured',
            revision: configured.revision,
        });
        await expect(service.get('webhook-token', { reason: 'Deliver webhook' })).resolves.toBe('super-secret');
        expect(registerRawForRedaction).toHaveBeenCalledWith('super-secret');
        expect('list' in service).toBe(false);

        await expect(service.set('webhook-token', 'must-not-win', {
            expectedRevision: missing.revision,
        })).rejects.toMatchObject({
            code: 'plugin_secret_revision_conflict',
            details: { currentRevision: configured.revision },
        });

        const deleted = await service.delete('webhook-token', {
            expectedRevision: configured.revision,
        });
        expect(await service.status('webhook-token')).toEqual({
            state: 'missing',
            revision: deleted.revision,
        });

        const raw = await readFile(
            join(happyHomeDir, 'plugins', 'plugins', 'secrets', 'acme.notifications', 'secrets.v1.json'),
            'utf8',
        );
        expect(raw).not.toContain('super-secret');
        expect(raw).not.toContain('must-not-win');
    });

    it('fails closed for an undeclared secret identifier', async () => {
        const { service } = await createFixture();

        await expect(service.status('not-declared')).rejects.toMatchObject({
            code: 'plugin_secret_undeclared',
        });
    });

    it('fails closed after its generation retires before reaching the encrypted owner', async () => {
        let current = true;
        const { service, registerRawForRedaction } = await createFixture({
            isGenerationCurrent: () => current,
        });
        await service.status('webhook-token');
        await service.set('webhook-token', 'deferred-secret');
        registerRawForRedaction.mockClear();
        const pendingRead = service.get('webhook-token');
        current = false;

        await expect(pendingRead).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
        expect(registerRawForRedaction).not.toHaveBeenCalled();
        await expect(service.status('webhook-token')).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
        await expect(service.get('webhook-token')).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
    });
});
