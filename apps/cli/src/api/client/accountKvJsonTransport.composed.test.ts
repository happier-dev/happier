import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { legacyAccountKvVectors } from '../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { createAccountKvHttpFixture } from '../../../../ui/sources/dev/testkit/fixtures/accountKvHttpFixture';
import { Encryption } from '../../../../ui/sources/sync/encryption/encryption';
import { createAccountKvJsonTransport } from '../../../../ui/sources/sync/ops/account/accountKvJsonTransport';
import { encodeBase64, encrypt, decodeBase64 } from '@/api/encryption';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { acquireRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { createCliAccountKvJsonTransport } from './accountKvJsonTransport';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function accountKvAuthorityFixture() {
    const channel = await createRequesterCurrentnessSocketHarness();
    const secret = new Uint8Array(32).fill(7);
    const accountId = 'kv-authority-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    let currentness: AccountEncryptionCurrentnessResponse = { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
        contentKeyFingerprint: fingerprint, updatedAt: 1 };
    let revoked = false;
    let currentnessReads = 0;
    let holdRead = false;
    const rowRequested = deferred();
    const releaseRow = deferred();
    const storage = createAccountKvHttpFixture();
    const server = createServer(async (request, response) => {
        try {
            if (request.url === '/v1/account/encryption/currentness') {
                currentnessReads++;
                response.statusCode = revoked ? 401 : 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(revoked ? { error: 'unauthorized' } : currentness));
            } else {
                if (holdRead && request.method === 'GET') { rowRequested.resolve(); await releaseRow.promise; }
                if (!await storage.handle(request, response)) { response.statusCode = 404; response.end(); }
            }
        } catch { response.statusCode = 500; response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: base });
    const transport = (key: string) => createCliAccountKvJsonTransport({ credentials: { token, encryption: { type: 'legacy', secret } },
        key, serverBaseUrl: base, resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${token}` }) });
    return {
        storage, transport, rowRequested, releaseRow,
        warm: () => holder.read(),
        currentnessReads: () => currentnessReads,
        holdRead: () => { holdRead = true; },
        change: (change: 'mode' | 'key' | 'epoch') => {
            if (change === 'epoch') revoked = true;
            else currentness = { ...currentness, version: 2, updatedAt: 2,
                ...(change === 'mode' ? { mode: 'plain', contentKeyFingerprint: null, signingKeyFingerprint: null }
                    : { contentKeyFingerprint: 'changed-content-key' }) };
        },
        seed: async (key: string, value: string) => { await axios.post(`${base}/v1/kv`, { mutations: [{ key, value, version: -1 }] }); },
        async close() {
            releaseRow.resolve();
            await holder.dispose();
            await channel.close();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

it('uses the warm admitted identity for pure Account KV reads without recurring currentness HTTP', async () => {
    const fixture = await accountKvAuthorityFixture();
    try {
        const key = 'todo.current-cipher';
        const value = { title: 'Current ciphertext' };
        const machineKey = deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(7));
        await fixture.seed(key, encodeBase64(encrypt(machineKey, 'dataKey', value)));
        await fixture.warm();
        await expect(fixture.transport(key).read()).resolves.toEqual({ value, version: 0 });
        await expect(fixture.transport(key).read()).resolves.toEqual({ value, version: 0 });
        expect(fixture.currentnessReads()).toBe(1);
        expect(fixture.storage.readRequests().filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { await fixture.close(); }
});

// p03redesign.F3 flow shape (PLAN 2026-11-14-p03-redesign X0): `client mode reads per write = 0`,
// `observation reads = 1 per Account+Home connection`. Registered as it.fails until R1/R2 land; their lane flips it.
it.fails('p03redesign.F3: N Account KV writes on a held observation cost 0 mode reads beyond the one connect read', async () => {
    const fixture = await accountKvAuthorityFixture();
    const writes = 3;
    try {
        await fixture.warm();
        for (let index = 0; index < writes; index += 1) {
            await expect(fixture.transport(`todo.f3-${index}`).compareAndSet({ title: `F3 write ${index}` }, -1))
                .resolves.toEqual({ success: true, version: 0 });
        }
        const modeReadsPerWrite = (fixture.currentnessReads() - 1) / writes;
        // it.fails hides the assertion message, so the measured count is printed for the flow-budgets row.
        console.info(`[p03redesign.F3] currentness reads=${fixture.currentnessReads()} for 1 connect + ${writes} writes`);
        expect({ observationReads: Math.min(fixture.currentnessReads(), 1), modeReadsPerWrite },
            `F3 current: ${fixture.currentnessReads()} currentness reads for 1 connect + ${writes} writes`)
            .toEqual({ observationReads: 1, modeReadsPerWrite: 0 });
    } finally { await fixture.close(); }
});

it.each(['mode', 'key', 'epoch'] as const)('freshly admits a KV write after a committed %s change before socket delivery', async change => {
    const fixture = await accountKvAuthorityFixture();
    try {
        await fixture.warm();
        fixture.change(change);
        const value = { title: 'Freshly admitted write' };
        const write = fixture.transport('todo.write').compareAndSet(value, -1);
        if (change === 'mode') {
            await expect(write).resolves.toEqual({ success: true, version: 0 });
            expect(JSON.parse(new TextDecoder().decode(decodeBase64(fixture.storage.read('todo.write')!.value))))
                .toEqual({ t: 'plain', v: value });
        } else {
            await expect(write).rejects.toMatchObject({
                code: change === 'epoch' ? 'account_encryption_currentness_unavailable' : 'account_storage_currentness_unavailable',
            });
            expect(fixture.storage.read('todo.write')).toBeUndefined();
            expect(fixture.storage.readRequests().filter(request => request.method === 'POST')).toHaveLength(0);
        }
        expect(fixture.currentnessReads()).toBe(2);
    } finally { await fixture.close(); }
});

it.each(['mode', 'key', 'epoch'] as const)('refuses legacy lazy re-sealing after a committed %s change while the row read is held', async change => {
    const fixture = await accountKvAuthorityFixture();
    const row = legacyAccountKvVectors[0];
    try {
        await fixture.seed(row.key, row.encoded);
        await fixture.warm();
        fixture.holdRead();
        const read = fixture.transport(row.key).read();
        const refused = expect(read).rejects.toMatchObject({
            code: change === 'epoch' ? 'account_encryption_currentness_unavailable' : 'account_storage_currentness_unavailable',
        });
        await fixture.rowRequested.promise;
        fixture.change(change);
        fixture.releaseRow.resolve();
        await refused;
        expect(fixture.storage.read(row.key)).toMatchObject({ value: row.encoded, version: 0 });
        expect(fixture.storage.readRequests().filter(request => request.method === 'POST')).toHaveLength(1);
        expect(fixture.currentnessReads()).toBe(2);
    } finally { await fixture.close(); }
});

it('UI legacy read re-seals real HTTP rows consumed by the paired CLI tasks.internal.list Action', async () => {
    const secret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const scope = { serverId: 'fx51-home', accountId: 'fx51-account' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    const storage = createAccountKvHttpFixture();
    const server = createServer(async (request, response) => {
        try {
            if (request.url === '/v1/account/encryption/currentness') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 }));
            } else if (!await storage.handle(request, response)) { response.statusCode = 404; response.end(); }
        } catch { response.statusCode = 500; response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        await axios.post(`${base}/v1/kv`, { mutations: legacyAccountKvVectors.map(row => ({ key: row.key, value: row.encoded, version: -1 })) });
        const encryption = await Encryption.create(secret);
        for (const row of legacyAccountKvVectors) {
            const ui = createAccountKvJsonTransport({ key: row.key, credentials: { token, secret: encodeBase64(secret, 'base64url') },
                encryption, request: (path, init) => fetch(`${base}${path}`, init), shouldContinue: () => true });
            await expect(ui.read()).resolves.toEqual({ value: row.value, version: 1 });
            await expect(ui.read()).resolves.toEqual({ value: row.value, version: 1 });
        }
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: { type: 'dataKey', machineKey,
            publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } }, sessionId: 'cli-global', mode: 'e2ee',
            ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' }, serverId: scope.serverId, serverHttpBaseUrl: base }));
        expect(await executor.execute('tasks.internal.list', {}, { surface: 'agent', authority: 'account_automation', bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { status: 'ok', scope, undoneOrder: ['fx51-legacy'], todos: [{ id: 'fx51-legacy',
                title: legacyAccountKvVectors[0].value.title, linkedSessions: legacyAccountKvVectors[0].value.linkedSessions }] } });
        for (const row of legacyAccountKvVectors) expect(storage.read(row.key)?.version).toBe(1);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
