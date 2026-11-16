import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliAccountKvJsonCollectionTransport, createCliAccountKvJsonTransport, resolveCliAccountStorageContext } from './accountKvJsonTransport';
import { ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { deriveAccountMachineKeyFromRecoverySecret, createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { legacyAccountKvVectors } from '../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { decryptResult, decodeBase64, encrypt, encodeBase64 } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import tweetnacl from 'tweetnacl';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

afterEach(() => vi.restoreAllMocks());
it('writes, reads and lists keyless plain rows through protocol-admitted Account KV HTTP', async () => {
    const key = 'todo.plain-protocol';
    const value = { title: 'Plain Account Task', notes: 'private to this Account' };
    let stored: { key: string; value: string; version: number } | undefined;
    // The HTTP boundary requires the same declaration as Home before accepting current envelopes.
    const admitted = (headers: unknown) => typeof headers === 'object' && headers !== null
        && Number(Reflect.get(headers, ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER)) >= CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION;
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (!admitted(config?.headers)) return { status: 426, data: { error: 'client-upgrade-required' } };
        return url.includes('?') ? { status: 200, data: { items: stored ? [stored] : [] } }
            : stored ? { status: 200, data: stored } : { status: 404 };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body, config) => {
        if (!admitted(config?.headers)) return { status: 426, data: { error: 'client-upgrade-required' } };
        const mutation = (body as { mutations: { key: string; value: string; version: number }[] }).mutations[0]!;
        stored = { key: mutation.key, value: mutation.value, version: mutation.version + 1 };
        return { status: 200, data: { success: true, results: [{ key: stored.key, version: stored.version }] } };
    });
    const transport = createCliAccountKvJsonCollectionTransport({ credentials: { token: 'plain-token', encryption: null },
        serverBaseUrl: 'https://plain-home.test', resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer plain-token' }) });
    await expect(transport.mutate([{ key, value, version: -1 }])).resolves.toEqual({ success: true, results: [{ key, version: 0 }] });
    expect(JSON.parse(Buffer.from(stored!.value, 'base64').toString())).toEqual({ t: 'plain', v: value });
    await expect(transport.read(key)).resolves.toEqual({ value, version: 0 });
    await expect(transport.list('todo.')).resolves.toEqual([{ key, value, version: 0 }]);
});
it.each(['fresh-authority', 'identity'] as const)('admits %s storage using in-hand requester custody rather than same-token disk keys', async usage => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_API_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']);
    try {
        await withTempDir('storage-requester-custody-', async home => {
            env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
            vi.resetModules();
            const persistence = await import('@/persistence');
            const { configuration } = await import('@/configuration');
            const { resolveCliAccountStorageContext: resolveStorage } = await import('./accountKvJsonTransport');
            const network = (await import('axios')).default;
            // HTTP is redirected; real persistence and Account mode admission remain in the path.
            vi.spyOn(network, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 2,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 } });
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester', usage })).toString('base64url')}.sig`;
            const active: StoredCredentials = { token, encryption: { type: 'legacy', secret: new Uint8Array(32).fill(17) } };
            const plain: StoredCredentials = { token, encryption: null };
            await persistence.writeStoredCredentialsForServerId(configuration.activeServerId, active);
            await expect(resolveStorage({ credentials: plain, serverBaseUrl: 'https://requester-storage.test', usage }))
                .resolves.toEqual({ mode: 'plain', material: null });
            await persistence.writeStoredCredentialsForServerId(configuration.activeServerId, plain);
            await expect(resolveStorage({ credentials: active, serverBaseUrl: 'https://requester-storage.test', usage }))
                .rejects.toMatchObject({ code: 'account_mode_downgrade_unverified', canTryAgain: false });
        });
    } finally {
        env.restore();
        vi.resetModules();
    }
});
it('settles invalid Account material as the existing storage refusal without masking currentness transport errors', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'current', updatedAt: 1 } });
    const machineKey = new Uint8Array(32).fill(11);
    for (const encryption of [
        { type: 'legacy' as const, secret: new Uint8Array(31) },
        { type: 'dataKey' as const, machineKey, publicKey: new Uint8Array(32) },
    ]) {
        await expect(resolveCliAccountStorageContext({ credentials: { token: 'token', encryption },
            serverBaseUrl: 'https://material-home.test', authorizationHeaders: { 'x-admitted-root': 'fixture' } }))
            .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
    }
    get.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await expect(resolveCliAccountStorageContext({ credentials: { token: 'token', encryption: null },
        serverBaseUrl: 'https://material-home.test', authorizationHeaders: { 'x-admitted-root': 'fixture' } }))
        .rejects.toMatchObject({ code: 'account_encryption_currentness_unavailable' });
});
it('authorizes the exact encoded CAS body, not an empty-body signature', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    let authorizedBody: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        expect(authorizedBody).toEqual(body);
        return { status: 200, data: { success: true, results: [{ key: 'todo.task-a', version: 2 }] } };
    });
    const transport = createCliAccountKvJsonTransport({ credentials: { token: 'token', encryption: null }, key: 'todo.task-a',
        serverBaseUrl: 'https://task-home.test', resolveAuthorizationHeaders: request => {
            if (request.method === 'POST') authorizedBody = 'body' in request ? request.body : undefined;
            return { Authorization: 'Bearer token' };
        } });
    await expect(transport.compareAndSet({ task: 'accepted' }, 1)).resolves.toEqual({ success: true, version: 2 });
});

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const legacy: StoredCredentials = { token: 'token', encryption: { type: 'legacy', secret } };
const dataKey: StoredCredentials = { token: 'token', encryption: { type: 'dataKey', machineKey,
    publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: legacy.encryption! }).contentPublicKeyFingerprint);

// Axios is the network boundary; cipher selection, opening, and CAS handling are real.
function accountKvHttp(initial: readonly { key: string; encoded: string }[]) {
    const rows = new Map(initial.map(row => [row.key, { value: row.encoded, version: 6 }]));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
            signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 } };
        const key = decodeURIComponent(new URL(url).pathname.slice('/v1/kv/'.length));
        const row = rows.get(key);
        return row ? { status: 200, data: { key, ...row } } : { status: 404 };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const mutations = (body as { mutations: { key: string; value: string; version: number }[] }).mutations;
        const errors = mutations.flatMap(row => row.version === (rows.get(row.key)?.version ?? -1) ? []
            : [{ key: row.key, error: 'version-mismatch', ...rows.get(row.key) }]);
        if (errors.length) return { status: 409, data: { success: false, errors } };
        return { status: 200, data: { success: true, results: mutations.map(row => {
            rows.set(row.key, { value: row.value, version: row.version + 1 });
            return { key: row.key, version: row.version + 1 };
        }) } };
    });
    const transport = (credentials: StoredCredentials, key: string) => createCliAccountKvJsonTransport({ credentials, key,
        serverBaseUrl: 'https://task-home.test', resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }) });
    return { rows, post, transport };
}

it('opens pinned legacy item/index, re-seals once, and exposes identical JSON to a data-key-only reader', async () => {
    const http = accountKvHttp(legacyAccountKvVectors);
    for (const row of legacyAccountKvVectors) {
        await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
        await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
        await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
    }
    expect(http.post).toHaveBeenCalledTimes(2);
});

it('writes from recovery-secret credentials using the data key', async () => {
    const http = accountKvHttp([]);
    const row = legacyAccountKvVectors[0];
    await expect(http.transport(legacy, row.key).compareAndSet(row.value, -1)).resolves.toEqual({ success: true, version: 0 });
    await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 0 });
});

it('does not overwrite a concurrent winner while re-sealing and returns its value/version', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    const winner = { ...row.value, title: 'QA FX51 concurrent edit', extraFutureField: { retained: true } };
    http.post.mockImplementationOnce(async () => {
        const value = encodeBase64(encrypt(machineKey, 'dataKey', winner));
        http.rows.set(row.key, { value, version: 7 });
        return { status: 409, data: { success: false, errors: [{ key: row.key, error: 'version-mismatch', value, version: 7 }] } };
    });
    await expect(http.transport(legacy, row.key).read()).resolves.toEqual({ value: winner, version: 7 });
    expect(decryptResult(machineKey, 'dataKey', decodeBase64(http.rows.get(row.key)!.value))).toEqual({ status: 'authenticated', value: winner });
    expect(http.post).toHaveBeenCalledTimes(1);
});

it('keeps legacy ciphertext intact when only data-key custody is available', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    await expect(http.transport(dataKey, row.key).read()).rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
    expect(http.rows.get(row.key)).toEqual({ value: row.encoded, version: 6 });
    expect(http.post).not.toHaveBeenCalled();
});

it('coalesces the persisted effect of concurrent secret-holding readers with version CAS', async () => {
    const row = legacyAccountKvVectors[0];
    const http = accountKvHttp([row]);
    const reads = await Promise.all([http.transport(legacy, row.key).read(), http.transport(legacy, row.key).read()]);
    expect(reads).toEqual([{ value: row.value, version: 7 }, { value: row.value, version: 7 }]);
    expect(http.rows.get(row.key)?.version).toBe(7);
    await expect(http.transport(dataKey, row.key).read()).resolves.toEqual({ value: row.value, version: 7 });
});

it('leaves plain Account rows keyless and unchanged on read', async () => {
    const value = { future: ['retained', false, null, 0] };
    const encoded = Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/currentness')
        ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
        : { status: 200, data: { key: 'workspace:plain', value: encoded, version: 4 } });
    const post = vi.spyOn(axios, 'post');
    const transport = createCliAccountKvJsonTransport({ credentials: { token: 'token', encryption: null }, key: 'workspace:plain',
        serverBaseUrl: 'https://plain-home.test', resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }) });
    await expect(transport.read()).resolves.toEqual({ value, version: 4 });
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalled();
});
