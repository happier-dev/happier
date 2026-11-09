import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { createSecretUseMaterialFixture } from './fetch/secretUseMaterial.testkit';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

afterEach(() => { vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each([{ mode: 'plain' as const, keyless: false }, { mode: 'e2ee' as const, keyless: false }, { mode: 'e2ee' as const, keyless: true }])
('runs authored $mode Account HTTP/secret custody with keyless=$keyless and no native services or disclosure', async ({ mode, keyless }) => {
    const home = await mkdtemp(join(tmpdir(), 'account-controller-services-'));
    const app = fastify();
    const origin = 'http://account-controller-home.test';
    const accountId = 'account-controller-owner';
    const sentinel = 'controller-custody-sentinel';
    const { credentials: materialCredentials, resources, accountMaterial } = createSecretUseMaterialFixture(mode,
        { accountId, resourceId: 'controller-resource', value: sentinel, revision: 1, keyless });
    const credentials = { ...materialCredentials, credentialProvenance: 'stored_session' as const };
    const token = credentials.token;
    const release = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode: mode });
    const { pluginId } = release;
    const rawSettings = {};
    const snapshot = { source: 'network' as const, settings: accountSettingsParse(rawSettings), rawSettings,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials), scopeKey: resolveAccountSettingsScopeKeyForToken(token) };
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: origin, isCurrent: async () => true });
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, settingsVersion: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: mode === 'plain' ? null
            : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(createAccountScopedCryptoMaterialSnapshotV1({
                accountEncryptionMode: 'e2ee', material: accountMaterial, dataKeyPublicKey: accountMaterial.publicKey }).contentPublicKeyFingerprint), updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: mode === 'plain' ? { t: 'plain', v: rawSettings }
        : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: accountMaterial, payload: rawSettings,
            randomBytes: length => new Uint8Array(length).fill(15) }) }, version: 1 }));
    app.get('/v1/account/saved-secrets/resources/materials', async () => resources);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const providerBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/variables') {
            providerBodies.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
            return Response.json({ accepted: true });
        }
        return Response.json({ features: {}, capabilities: {} });
    }));
    try {
        await runWithServerHttpBaseUrl(origin, () => release.publishArtifacts({ ...credentials,
            encryption: mode === 'plain' ? null : accountMaterial }));
        const cli = createCliActionExecutor({ token, credentials, happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'account-controller-home', serverHttpBaseUrl: origin, savedSecretOperationContext: operation });
        const invoke = (key: string) => cli.execute('action.invoke', { action: { pluginId, localId: 'controller-request' }, input: { key } }, { surface: 'cli' });
        const result = await invoke('use');
        if (keyless) {
            expect(result).toMatchObject({ ok: false, errorCode: 'secret_use_client_required' });
            expect(providerBodies).toEqual([]);
            return;
        }
        expect(result, JSON.stringify({ errorCode: result.ok ? null : result.errorCode,
            providerWrites: providerBodies.length, mode, keyless })).toMatchObject({ ok: true, result: { status: 200, secretState: 'missing',
            response: JSON.stringify({ accepted: true }), nativeServices: [] } });
        expect(providerBodies).toEqual([{ value: sentinel }]);
        expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(await invoke('invalid-pointer')).toMatchObject({ ok: false, errorCode: 'invalid_request' });
        expect(await invoke('wrong-revision')).toMatchObject({ ok: false, errorCode: 'secret_missing' });
        expect(await invoke('undeclared-secret')).toMatchObject({ ok: true, result: { status: 200, secretState: 'missing' } });
        expect(await invoke('wrong-origin')).toMatchObject({ ok: true, result: { status: 200 } });
        expect(await invoke('wrong-method')).toMatchObject({ ok: true, result: { status: 200 } });
        expect(providerBodies).toEqual(Array.from({ length: 4 }, () => ({ value: sentinel })));
    } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
});
