import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { normalizePluginStorageNamespace } from './pluginNamespace';

import * as pluginSecretsContext from './secrets';

import {
    createDaemonPluginSecretCustodyRouter,
    createDeclaredPluginSecretsService,
    createPluginSecretStore,
    createPluginSecretCustodyRouter,
    createStableDeclaredPluginSecretsHost,
} from './secrets';

describe('declared plugin secret custody', () => {
    it('drops retired secret entry fields on stored reads without changing ciphertext', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-secret-retired-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        try {
            const store = createPluginSecretStore({ pluginId: 'acme.plugin', paths, secretKey: new Uint8Array(32).fill(7) });
            await store.set('token', 'retained-secret');
            const path = join(paths.secretsDir, normalizePluginStorageNamespace('acme.plugin'), 'secrets.v1.json');
            const stored = JSON.parse(await readFile(path, 'utf8'));
            stored.retired = true;
            stored.secrets.token.retired = true;
            stored.secrets.token.encryptedValue.retired = true;
            await writeFile(path, JSON.stringify(stored));
            await expect(store.get('token')).resolves.toBe('retained-secret');
        } finally { await rm(happyHomeDir, { recursive: true, force: true }); }
    });
    it('does not retain the retired HostAccess-gated secrets service', () => {
        expect('createStablePluginSecretsService' in pluginSecretsContext).toBe(false);
    });

    it('fails closed instead of creating the retired local plugin secret key', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-secret-custody-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        try {
            // Exercise the runtime boundary a stale caller would reach; a
            // declared secret must arrive with custody-owned key material.
            const store = createPluginSecretStore({
                pluginId: 'acme.plugin',
                paths,
            });

            await expect(store.set('token', 'must-not-create-a-local-key')).rejects.toMatchObject({
                code: 'PLUGIN_SECRETS_KEY_REQUIRED',
            });
            await expect(store.get('token')).rejects.toMatchObject({
                code: 'PLUGIN_SECRETS_KEY_REQUIRED',
            });
            await expect(store.list()).rejects.toMatchObject({
                code: 'PLUGIN_SECRETS_KEY_REQUIRED',
            });
            await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('routes only explicit daemon declarations to the purpose-derived local owner and fails Account custody closed', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-secret-custody-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const deriveSecretKey = vi.fn(() => new Uint8Array(32).fill(7));
        try {
            const daemonCustody = createDaemonPluginSecretCustodyRouter({
                paths,
                resolveDeviceLocalSecretStorage: async () => ({
                    deriveSecretKey,
                }),
            });
            const custody = createPluginSecretCustodyRouter({
                daemon: daemonCustody.resolve,
            });
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.plugin',
                declarations: [
                    { id: 'daemon-token', custody: 'daemon' },
                    { id: 'account-token', custody: 'account' },
                ],
                resolveCustody: custody.resolve,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: vi.fn(),
            });

            expect(await service.status('account-token')).toMatchObject({ state: 'unavailable' });
            await expect(service.get('account-token')).rejects.toMatchObject({
                code: 'plugin_secret_custody_unavailable',
            });

            const missing = await service.status('daemon-token');
            await service.set('daemon-token', 'daemon-only-secret', {
                expectedRevision: missing.revision,
            });

            expect(await service.get('daemon-token')).toBe('daemon-only-secret');
            expect(deriveSecretKey).toHaveBeenCalledWith({ purpose: 'plugin_secrets' });
            await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('administers an origin-bound daemon secret through the secret-native port without reading its retained legacy slot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-secret-origin-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const pluginId = 'acme.plugin';
        const secretId = 'daemon-token';
        const originOne = 'https://api.example.test';
        const originTwo = 'https://other.example.test';
        const originDifferentPort = 'https://api.example.test:8443';
        const loopbackHttps = 'https://localhost';
        const loopbackHttp = 'http://localhost';
        try {
            const daemonCustody = createDaemonPluginSecretCustodyRouter({
                paths,
                resolveDeviceLocalSecretStorage: async () => ({
                    deriveSecretKey: () => new Uint8Array(32).fill(7),
                }),
            });
            const declaration = Object.freeze({
                id: secretId,
                custody: 'daemon' as const,
                managedServiceOrigin: Object.freeze({ endpointSettingId: 'endpoint' }),
            });
            const directCustody = daemonCustody.resolve({ pluginId, declaration });
            if (!directCustody) throw new Error('Expected daemon custody');

            // This is retained encrypted legacy data. The origin-bound path
            // must not read, copy, or treat it as a fallback.
            await directCustody.set({ secretId, value: 'legacy-global-secret' });

            const host = createStableDeclaredPluginSecretsHost({
                declarations: [{ pluginId, declaration }, { pluginId, declaration: { id: 'ordinary-token', custody: 'daemon' } }],
                resolveCustody: createPluginSecretCustodyRouter({
                    daemon: daemonCustody.resolve,
                }).resolve,
            });
            const port = host.bindDaemonPluginSecretAdministrationPort({
                pluginId,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });
            if (!port) throw new Error('Expected daemon secret administration port');

            // Trusted code may select an explicit origin slot without a
            // manifest permission. The unscoped token keeps its own identity.
            const ordinaryCustody = daemonCustody.resolve({ pluginId, declaration: { id: 'ordinary-token', custody: 'daemon' } });
            if (!ordinaryCustody) throw new Error('Expected ordinary daemon custody');
            await port.set({ secretId: 'ordinary-token', value: 'ordinary-global-secret' });
            const scopedMissing = await port.status({ secretId: 'ordinary-token', canonicalOrigin: originOne });
            expect(scopedMissing.state).toBe('missing');
            await port.set({ secretId: 'ordinary-token', canonicalOrigin: originOne, value: 'ordinary-origin-secret',
                expectedRevision: scopedMissing.revision });
            expect((await ordinaryCustody.get('ordinary-token'))?.value).toBe('ordinary-global-secret');
            expect((await ordinaryCustody.get('ordinary-token', { canonicalOrigin: originOne }))?.value).toBe('ordinary-origin-secret');

            await expect(port.status({ secretId })).rejects.toMatchObject({
                code: 'plugin_secret_origin_required',
            });
            const missing = await port.status({ secretId, canonicalOrigin: originOne });
            expect(missing).toMatchObject({ state: 'missing' });
            await port.set({
                secretId,
                canonicalOrigin: originOne,
                value: 'origin-one-secret',
                expectedRevision: missing.revision,
            });
            expect(await port.status({ secretId, canonicalOrigin: originOne })).toMatchObject({
                state: 'configured',
            });
            expect(await port.status({ secretId, canonicalOrigin: originTwo })).toMatchObject({
                state: 'missing',
            });
            // A non-default port is a different credential identity even on
            // the same HTTPS hostname.
            expect(await port.status({ secretId, canonicalOrigin: originDifferentPort })).toMatchObject({
                state: 'missing',
            });
            const loopbackMissing = await port.status({ secretId, canonicalOrigin: loopbackHttps });
            await port.set({
                secretId,
                canonicalOrigin: loopbackHttps,
                value: 'loopback-https-secret',
                expectedRevision: loopbackMissing.revision,
            });
            // Scheme is part of `URL.origin`; HTTP never aliases HTTPS.
            expect(await port.status({ secretId, canonicalOrigin: loopbackHttp })).toMatchObject({
                state: 'missing',
            });

            const sdkSecrets = host.bind({
                pluginId,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                registerRawForRedaction: vi.fn(),
            });
            if (!sdkSecrets) throw new Error('Expected SDK secrets service');
            expect(await sdkSecrets.status(secretId)).toMatchObject({ state: 'unavailable' });
            await expect(sdkSecrets.get(secretId)).rejects.toMatchObject({
                code: 'plugin_secret_origin_required',
            });

            expect((await directCustody.get(secretId))?.value).toBe('legacy-global-secret');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it.each(['account', 'daemon'] as const)(
        'returns the acknowledged %s custody mutation result when currentness retires immediately afterward',
        async (custody) => {
            let generationCurrent = true;
            const set = vi.fn(async () => {
                generationCurrent = false;
                return Object.freeze({ revision: 'set-acknowledged' });
            });
            const remove = vi.fn(async () => {
                generationCurrent = false;
                return Object.freeze({ revision: 'delete-acknowledged' });
            });
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.plugin',
                declarations: [{ id: 'token', custody }],
                resolveCustody: () => Object.freeze({
                    async status() {
                        return Object.freeze({ state: 'missing' as const, revision: 'before' });
                    },
                    async get() {
                        return null;
                    },
                    set,
                    delete: remove,
                }),
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => generationCurrent,
                registerRawForRedaction: vi.fn(),
            });

            await expect(service.set('token', 'acknowledged-value')).resolves.toEqual({
                revision: 'set-acknowledged',
            });
            expect(set).toHaveBeenCalledOnce();

            generationCurrent = true;
            await expect(service.delete('token')).resolves.toEqual({
                revision: 'delete-acknowledged',
            });
            expect(remove).toHaveBeenCalledOnce();
        },
    );
});
