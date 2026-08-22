import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { collectDeclaredPluginSecrets } from './declaredPluginSecrets';
import {
    createDaemonPluginSecretCustodyRouter,
    createDeclaredPluginSecretsService,
    createPluginSecretCustodyRouter,
} from './secrets';

const PLUGIN_ID = 'acme.notifications';
const SECRET_ID = 'nested/token';

async function createManifestDeclaredSecretService() {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declared-secret-id-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const manifest = PluginManifestV2Schema.parse({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Notifications',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        secrets: [{ id: SECRET_ID, custody: 'daemon' }],
    });
    const declarations = collectDeclaredPluginSecrets([{
        pluginId: manifest.id,
        manifest,
    }]);
    const daemonCustody = createDaemonPluginSecretCustodyRouter({
        paths,
        resolveDeviceLocalSecretStorage: async () => ({
            deriveSecretKey: () => new Uint8Array(32).fill(7),
        }),
    });
    const service = createDeclaredPluginSecretsService({
        pluginId: manifest.id,
        declarations: declarations.map(({ declaration }) => declaration),
        resolveCustody: createPluginSecretCustodyRouter({ daemon: daemonCustody.resolve }).resolve,
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        registerRawForRedaction: vi.fn(),
    });
    return { happyHomeDir, paths, service };
}

describe('manifest-declared plugin secret identifiers', () => {
    it('preserves the generic Account endpoint relation for an origin-bound daemon secret', () => {
        const declarations = collectDeclaredPluginSecrets([{
            pluginId: PLUGIN_ID,
            manifest: {
                contributes: {
                    settings: [{
                        fields: [{
                            id: 'endpoint',
                            secret: false,
                        }, {
                            id: 'password',
                            secret: {
                                custody: 'daemon',
                                managedServiceOrigin: { endpointSettingId: 'endpoint' },
                            },
                        }],
                    }],
                    notificationChannels: [],
                },
            },
        }]);

        expect(declarations).toContainEqual({
            pluginId: PLUGIN_ID,
            declaration: {
                id: 'password',
                custody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'endpoint' },
            },
        });
    });

    it('uses a slash-containing direct declaration as an opaque daemon-secret key', async () => {
        const { happyHomeDir, paths, service } = await createManifestDeclaredSecretService();
        try {
            const missing = await service.status(SECRET_ID);
            expect(missing.state).toBe('missing');

            const configured = await service.set(SECRET_ID, 'secret-value', {
                expectedRevision: missing.revision,
            });
            await expect(service.get(SECRET_ID)).resolves.toBe('secret-value');

            const secretFile = join(paths.secretsDir, PLUGIN_ID, 'secrets.v1.json');
            const stored = JSON.parse(await readFile(secretFile, 'utf8')) as Readonly<{
                secrets: Readonly<Record<string, unknown>>;
            }>;
            expect(Object.hasOwn(stored.secrets, SECRET_ID)).toBe(true);
            expect(stored.secrets[SECRET_ID]).not.toBe('secret-value');
            await expect(access(join(paths.secretsDir, PLUGIN_ID, 'nested'))).rejects.toMatchObject({
                code: 'ENOENT',
            });

            const deleted = await service.delete(SECRET_ID, {
                expectedRevision: configured.revision,
            });
            await expect(service.status(SECRET_ID)).resolves.toEqual({
                state: 'missing',
                revision: deleted.revision,
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
