import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createAccountKvJsonTransport } from './accountKvJsonTransport';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';

// The shared sync singleton is the mounted application boundary, not a second cipher implementation.
const mounted = vi.hoisted(() => ({ encryption: null as Encryption | null,
    credentials: null as AuthCredentials | null, getCredentials() { return this.credentials; } }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => mounted }));

const key = 'workspace:tabs:v1';
const credentials: AuthCredentials = { token: 'Account-A' };
const plain = (value: unknown) => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };

describe('Account KV JSON transport', () => {
    beforeEach(() => { vi.clearAllMocks(); mounted.encryption = null; mounted.credentials = null; });

    async function encryptedAccount() {
        const secret = new Uint8Array(32).fill(7);
        mounted.encryption = await Encryption.create(secret);
        const material = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret },
        });
        mounted.credentials = { token: 'Account-A', secret: encodeBase64(secret, 'base64url') };
        return {
            credentials: mounted.credentials,
            currentness: { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'current-signing',
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) },
            encryption: mounted.encryption,
        };
    }

    it('round-trips E2EE reads and CAS writes with the mounted real Account cipher', async () => {
        const account = await encryptedAccount();
        const encrypted = await account.encryption.encryptRaw({ tabs: ['remote'] });
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ key, value: encrypted, version: 4 }))
            .mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ success: true, results: [{ key, version: 5 }] }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: { tabs: ['remote'] }, version: 4 });
        await expect(transport.compareAndSet({ tabs: ['local'] }, 4)).resolves.toEqual({ success: true, version: 5 });
        const body = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
        await expect(account.encryption.decryptRaw(body.mutations[0].value)).resolves.toEqual({ tabs: ['local'] });
    });

    it('uses the explicitly captured E2EE Account cipher while another Home is mounted', async () => {
        const account = await encryptedAccount();
        const encoded = await account.encryption.encryptRaw({ boards: ['target'] });
        mounted.credentials = { ...account.credentials, token: 'another-Home' };
        mounted.encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ key, value: encoded, version: 4 }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request,
            encryption: account.encryption, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: { boards: ['target'] }, version: 4 });
    });

    it('rejects unavailable or mismatched E2EE material before fetching or mutating KV', async () => {
        const account = await encryptedAccount();
        const request = vi.fn<ServerFetch>().mockImplementation(async () => json({ ...account.currentness, contentKeyFingerprint: 'other-key' }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.read()).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        mounted.encryption = null;
        await expect(transport.compareAndSet({}, -1)).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness', '/v1/account/encryption/currentness']);
    });

    it('rejects unreadable E2EE records rather than interpreting them as absence', async () => {
        const account = await encryptedAccount();
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ key, value: 'corrupt-ciphertext', version: 4 }));
        await expect(createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true }).read())
            .rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
    });

    it('rejects another mounted Account cipher before writing with the newly published credentials', async () => {
        const account = await encryptedAccount();
        mounted.credentials = { ...account.credentials, token: 'previous-Account' };
        mounted.encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ success: true, results: [{ key, version: 0 }] }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.compareAndSet({ tabs: ['local'] }, -1))
            .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness']);
    });

    it('opens keyless plain records and the authoritative CAS conflict record', async () => {
        const remote = { tabs: ['remote'] };
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ key, value: plain(remote), version: 4 }))
            .mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ success: false, errors: [{ key, error: 'version-mismatch', value: plain(remote), version: 5 }] }, 409));
        const transport = createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: remote, version: 4 });
        await expect(transport.compareAndSet({ tabs: ['local'] }, 4)).resolves.toEqual({ success: false, value: remote, version: 5 });
        const mutationBody = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
        expect(mutationBody.mutations).toEqual([{ key, value: plain({ tabs: ['local'] }), version: 4 }]);
    });

    it('rejects ciphertext in a plain Account before returning its value', async () => {
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ key, value: 'encrypted-record', version: 4 }));
        await expect(createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => true }).read())
            .rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
    });

    it('keeps tombstone conflict versions distinct from explicit JSON null records', async () => {
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ success: false, errors: [{ key, error: 'version-mismatch', value: null, version: 7 }] }, 409))
            .mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ key, value: plain(null), version: 7 }));
        const transport = createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => true });
        await expect(transport.compareAndSet({}, -1)).resolves.toEqual({ success: false, value: null, version: 7, tombstone: true });
        await expect(transport.read()).resolves.toEqual({ value: null, version: 7 });
    });

    it('suppresses an in-flight read when its captured Account retires', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockImplementationOnce(async () => { current = false; return json({ key, value: plain({ secret: 'Account-A' }), version: 4 }); });
        await expect(createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => current }).read())
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
    });

    it('preserves a successful CAS receipt after retirement but does not disclose a retired conflict record', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockImplementationOnce(async () => { current = false; return json({ success: true, results: [{ key, version: 5 }] }); });
        const transport = createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => current });
        await expect(transport.compareAndSet({ tabs: ['captured'] }, 4)).resolves.toEqual({ success: true, version: 5 });

        current = true;
        request.mockResolvedValueOnce(json(currentness)).mockImplementationOnce(async () => {
            current = false;
            return json({ success: false, errors: [{ key, error: 'version-mismatch', value: plain({ private: 'Account-A' }), version: 6 }] }, 409);
        });
        await expect(transport.compareAndSet({ tabs: ['captured'] }, 5)).rejects.toMatchObject({ code: 'account_kv_scope_retired' });
    });

    it('does not mutate after currentness retires the captured Account', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>().mockResolvedValue(json({ success: true, results: [{ key, version: 1 }] }))
            .mockImplementationOnce(async () => { current = false; return json(currentness); });
        await expect(createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => current }).compareAndSet({}, -1))
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness']);
    });
});
