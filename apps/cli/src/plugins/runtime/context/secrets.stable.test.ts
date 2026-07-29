import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
    createStablePluginSecretsService,
    type StablePluginSecretAccessCheck,
} from './secrets';

async function createFixture(params?: Readonly<{
    authorize?: (check: StablePluginSecretAccessCheck) => boolean | Promise<boolean>;
    isGenerationCurrent?: () => boolean;
}>) {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-stable-secrets-'));
    const registerForRedaction = vi.fn<(value: string) => void>();
    const authorize = vi.fn(params?.authorize ?? (() => true));
    const service = createStablePluginSecretsService({
        pluginId: 'acme.notifications',
        paths: resolvePluginStorePaths({ happyHomeDir }),
        secretKey: new Uint8Array(32).fill(7),
        randomBytes: (length) => new Uint8Array(length).fill(3),
        declaredScopes: [{
            secretIds: ['webhook-token'],
            access: ['read', 'write', 'delete'],
        }],
        signal: new AbortController().signal,
        isGenerationCurrent: params?.isGenerationCurrent ?? (() => true),
        authorize,
        registerForRedaction,
    });
    return { happyHomeDir, service, authorize, registerForRedaction };
}

describe('stable scoped plugin secrets service', () => {
    it('uses the encrypted owner for configured/missing state, opaque CAS revisions, and redaction registration', async () => {
        const { happyHomeDir, service, registerForRedaction } = await createFixture();

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
        expect(registerForRedaction).toHaveBeenCalledWith('super-secret');
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

    it('fails closed for undeclared and terminally denied secret access', async () => {
        let authorized = true;
        const { service, authorize } = await createFixture({ authorize: () => authorized });

        await expect(service.status('not-declared')).rejects.toMatchObject({
            code: 'plugin_secret_undeclared',
        });
        expect(authorize).not.toHaveBeenCalled();

        const missing = await service.status('webhook-token');
        await service.set('webhook-token', 'configured', { expectedRevision: missing.revision });
        authorized = false;

        await expect(service.status('webhook-token')).resolves.toMatchObject({ state: 'denied' });
        await expect(service.get('webhook-token')).rejects.toMatchObject({ code: 'plugin_secret_access_denied' });
        await expect(service.set('webhook-token', 'denied')).rejects.toMatchObject({ code: 'plugin_secret_access_denied' });
        await expect(service.delete('webhook-token')).rejects.toMatchObject({ code: 'plugin_secret_access_denied' });
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.notifications',
            secretId: 'webhook-token',
            access: 'read',
        }));
    });

    it('fails closed after its generation retires before reaching the encrypted owner', async () => {
        let current = true;
        const { service } = await createFixture({ isGenerationCurrent: () => current });
        await service.status('webhook-token');
        current = false;

        await expect(service.status('webhook-token')).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
        await expect(service.get('webhook-token')).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
    });
});
