import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createAccountKvJsonTransport } from './accountKvJsonTransport';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { legacyAccountKvVectors } from '../../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { createSocketAccountEncryptionObservation } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createOperationAccountCurrentnessSource } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import {
    createAccountScopedCryptoMaterialSnapshotV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

installApprovalCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
async function mountAccount(accountCredentials: AuthCredentials) {
    await connection?.dispose();
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://account-kv.test', credentials: accountCredentials,
        request: async (input) => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(accountCredentials)) : null,
    });
}
afterEach(async () => { await connection?.dispose(); connection = null; });

const key = 'workspace:tabs:v1';
const credentials: AuthCredentials = { token: createAccountTokenForTests('Account-A') };
const plain = (value: unknown) => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };

describe('Account KV JSON transport', () => {
    beforeEach(async () => { vi.clearAllMocks(); await mountAccount(credentials); });

    async function encryptedAccount() {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        const material = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret },
        });
        const accountCredentials = { token: credentials.token, secret: encodeBase64(secret, 'base64url') };
        await mountAccount(accountCredentials);
        return {
            credentials: accountCredentials,
            currentness: { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'current-signing',
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) },
            encryption,
        };
    }

    async function observedKvBoundary(accountCredentials: AuthCredentials, initial: AccountEncryptionCurrentnessResponse) {
        const kv = createAccountKvHttpFixture();
        const { createServer } = getVitestNodeBuiltin<typeof import('node:http')>('node:http');
        let fact = initial;
        let currentnessReads = 0;
        const server = createServer((request, response) => {
            if (request.url === '/v1/account/encryption/currentness') {
                currentnessReads++;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(fact));
                return;
            }
            void kv.handle(request, response).then(handled => {
                if (!handled) { response.statusCode = 404; response.end(); }
            }).catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('KV fixture did not bind');
        const endpointUrl = `http://127.0.0.1:${address.port}`;
        setRuntimeFetch((input, init) => fetch(input, init));
        const freshRequest = createServerFetchAtEndpoint({ endpointUrl, credentials: accountCredentials });
        const observation = createSocketAccountEncryptionObservation({
            credentials: accountCredentials, endpointUrl, runtimeOrigin: endpointUrl,
            homeCarrierEndpointId: null, request: freshRequest, isCurrent: () => true,
        });
        observation.connected();
        await observation.binding.read();
        const request = createServerFetchAtEndpoint({ endpointUrl, credentials: accountCredentials,
            accountEncryptionObservation: observation.binding });
        return {
            kv, request, readCount: () => currentnessReads,
            commitModeWithoutPush: (next: AccountEncryptionCurrentnessResponse) => { fact = next; },
            seed: async (rowKey: string, value: string) => {
                const response = await fetch(`${endpointUrl}/v1/kv`, { method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mutations: [{ key: rowKey, value, version: -1 }] }) });
                expect(response.status).toBe(200);
            },
            close: async () => {
                observation.dispose();
                resetRuntimeFetch();
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            },
        };
    }

    it('borrows one owned identity for repeated current-format KV reads while explicit writes remain fresh', async () => {
        const boundary = await observedKvBoundary(credentials, { ...currentness, mode: 'plain' });
        const admission = createOperationAccountCurrentnessSource({ credentials, request: boundary.request });
        try {
            await boundary.seed(key, plain({ tabs: ['remote'] }));
            const transport = createAccountKvJsonTransport({ key, credentials, request: boundary.request,
                encryption: null, shouldContinue: () => true, readIdentity: admission.read });
            for (let index = 0; index < 3; index++) {
                await expect(transport.read()).resolves.toEqual({ value: { tabs: ['remote'] }, version: 0 });
            }
            expect(boundary.readCount()).toBe(1);
            await expect(transport.compareAndSet({ tabs: ['local'] }, 0)).resolves.toEqual({ success: true, version: 1 });
            expect(boundary.readCount()).toBe(2);
        } finally { admission.dispose(); await boundary.close(); }
    });

    it('refuses a legacy re-seal after private opening when a committed mode change has no socket publication yet', async () => {
        const account = await encryptedAccount();
        const fixture = legacyAccountKvVectors[0];
        const boundary = await observedKvBoundary(account.credentials, { ...account.currentness, mode: 'e2ee' });
        const open = nacl.secretbox.open;
        // This external crypto boundary still performs real authentication. Home
        // commits after the plaintext opens, before the lazy writer can seal it.
        const opened = vi.spyOn(nacl.secretbox, 'open').mockImplementation((...args) => {
            const plaintext = open(...args);
            if (plaintext) boundary.commitModeWithoutPush({ ...currentness, mode: 'plain', version: 2, updatedAt: 2 });
            return plaintext;
        });
        try {
            await boundary.seed(fixture.key, fixture.encoded);
            const transport = createAccountKvJsonTransport({ key: fixture.key, credentials: account.credentials,
                request: boundary.request, encryption: account.encryption, shouldContinue: () => true });
            // Downgrade pin A′ refuses the Home's plain report while these keys remain active,
            // before the re-seal writer can compare admitted modes (OWNER-RULINGS 2026-10-30).
            await expect(transport.read()).rejects.toMatchObject({
                code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable',
                cause: { code: 'account_mode_downgrade_unverified' },
            });
            expect(opened).toHaveBeenCalled();
            expect(boundary.kv.read(fixture.key)).toEqual({ key: fixture.key, value: fixture.encoded, version: 0 });
            expect(boundary.kv.readRequests().filter(request => request.path === '/v1/kv' && request.method === 'POST')).toHaveLength(1);
            expect(boundary.readCount()).toBe(2);
        } finally {
            opened.mockRestore();
            await boundary.close();
        }
    });

    it('round-trips E2EE reads and CAS writes with the mounted real Account cipher', async () => {
        const account = await encryptedAccount();
        const encrypted = await account.encryption.encryptRaw({ tabs: ['remote'] });
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ values: [{ key, value: encrypted, version: 4 }] }))
            .mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ success: true, results: [{ key, version: 5 }] }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: { tabs: ['remote'] }, version: 4 });
        await expect(transport.compareAndSet({ tabs: ['local', 'é🚀'], future: [null, false, 0, ''] }, 4)).resolves.toEqual({ success: true, version: 5 });
        const body = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
        await expect(account.encryption.decryptRaw(body.mutations[0].value)).resolves.toEqual({ tabs: ['local', 'é🚀'], future: [null, false, 0, ''] });
    });

    it('re-seals a pinned predecessor row once through the real Account JSON transport', async () => {
        const account = await encryptedAccount();
        const fixture = legacyAccountKvVectors[0];
        let row = { key: fixture.key, value: fixture.encoded as string, version: 6 };
        const request: ServerFetch = async (path, init) => {
            if (path.endsWith('/currentness')) return json(account.currentness);
            if (path === '/v1/kv/bulk') return json({ values: [row] });
            const body = JSON.parse(String(init?.body));
            expect(body.mutations[0].version).toBe(row.version);
            row = { ...row, value: body.mutations[0].value, version: row.version + 1 };
            return json({ success: true, results: [{ key: row.key, version: row.version }] });
        };
        const transport = createAccountKvJsonTransport({ key: fixture.key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: fixture.value, version: 7 });
        const reader = await Encryption.createFromContentKeyPair({ machineKey: account.encryption.getContentPrivateKey(), publicKey: account.encryption.contentDataKey });
        await expect(reader.decryptRaw(row.value)).resolves.toEqual(fixture.value);
        await expect(transport.read()).resolves.toEqual({ value: fixture.value, version: 7 });
    });

    it('uses the explicitly captured E2EE Account cipher while another Home is mounted', async () => {
        const account = await encryptedAccount();
        const encoded = await account.encryption.encryptRaw({ boards: ['target'] });
        await mountAccount({ token: createAccountTokenForTests('Other-Account'), secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') });
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ values: [{ key, value: encoded, version: 4 }] }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request,
            encryption: account.encryption, shouldContinue: () => true });
        await expect(transport.read()).resolves.toEqual({ value: { boards: ['target'] }, version: 4 });
    });

    it('rejects unavailable or mismatched E2EE material before fetching or mutating KV', async () => {
        const account = await encryptedAccount();
        const request = vi.fn<ServerFetch>().mockImplementation(async () => json({ ...account.currentness, contentKeyFingerprint: 'other-key' }));
        const transport = createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true });
        await expect(transport.read()).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        getSyncSingleton().encryption = null;
        await expect(transport.compareAndSet({}, -1)).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness', '/v1/account/encryption/currentness']);
    });

    it('rejects unreadable E2EE records rather than interpreting them as absence', async () => {
        const account = await encryptedAccount();
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(account.currentness))
            .mockResolvedValueOnce(json({ values: [{ key, value: 'corrupt-ciphertext', version: 4 }] }));
        await expect(createAccountKvJsonTransport({ key, credentials: account.credentials, request, shouldContinue: () => true }).read())
            .rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
    });

    it('rejects another mounted Account cipher before writing with the newly published credentials', async () => {
        const account = await encryptedAccount();
        await mountAccount({ token: createAccountTokenForTests('Previous-Account'), secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') });
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
            .mockResolvedValueOnce(json({ values: [{ key, value: plain(remote), version: 4 }] }))
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
            .mockResolvedValueOnce(json({ values: [{ key, value: 'encrypted-record', version: 4 }] }));
        await expect(createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => true }).read())
            .rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
    });

    it('keeps tombstone conflict versions distinct from explicit JSON null records', async () => {
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ success: false, errors: [{ key, error: 'version-mismatch', value: null, version: 7 }] }, 409))
            .mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ values: [{ key, value: plain(null), version: 7 }] }));
        const transport = createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => true });
        await expect(transport.compareAndSet({}, -1)).resolves.toEqual({ success: false, value: null, version: 7, tombstone: true });
        await expect(transport.read()).resolves.toEqual({ value: null, version: 7 });
    });

    it('suppresses an in-flight read when its captured Account retires', async () => {
        let current = true;
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockImplementationOnce(async () => { current = false; return json({ values: [{ key, value: plain({ secret: 'Account-A' }), version: 4 }] }); });
        await expect(createAccountKvJsonTransport({ key, credentials, request, shouldContinue: () => current }).read())
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
    });

});
