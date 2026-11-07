import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { legacyAccountKvVectors } from '../../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import type { KvSocketChange } from '@/sync/engine/socket/kvUpdateDispatcher';
import type { KvMutateRequest } from '@/sync/api/account/apiKv';

const LEGACY_SECRET_BYTES = new Uint8Array(32).fill(7);
const LEGACY_SECRET = encodeBase64(LEGACY_SECRET_BYTES, 'base64url');
const LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(
            deriveAccountMachineKeyFromRecoverySecret(LEGACY_SECRET_BYTES),
        ).publicKey,
    );

// Install only external Home HTTP, Socket.IO and credential-custody boundaries
// before importing the real mode, material admission, Todo and store owners.
const network = await installSessionOpsNetworkBoundary();
const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { storage } = await import('@/sync/domains/state/storage');
const { Encryption } = await import('@/sync/encryption/encryption');
const { applyTodoSocketUpdates } = await import('./syncTodos');
const { TodoStoredContentUnavailableError } = await import('@/sync/domains/todos/todoStoredContent');
const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');

const plainHome = await network.addHome('https://todo-socket-plain.example.test', 'todo-plain');
const plainCredentials = { token: plainHome.token };
const encryptedCredentials = { token: createAccountTokenForTests('todo-encrypted'), secret: LEGACY_SECRET };
const encryptedHome = await network.addHome('https://todo-socket-encrypted.example.test', 'todo-encrypted', {
    credentials: encryptedCredentials, encryptionMode: 'e2ee',
});
const requests = {
    plain: createServerFetchAtEndpoint({ endpointUrl: plainHome.serverUrl, serverId: plainHome.id, credentials: plainCredentials }),
    e2ee: createServerFetchAtEndpoint({ endpointUrl: encryptedHome.serverUrl, serverId: encryptedHome.id, credentials: encryptedCredentials }),
};
const encryptedCurrentness = AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
    contentKeyFingerprint: LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'available' },
});
const item = (title: string) => ({ id: 'item-1', title, done: false, createdAt: 1, updatedAt: 1 });
const retainedState = () => ({ todos: {
    retained: { id: 'retained', title: 'Retained task', done: false, createdAt: 1, updatedAt: 1 },
}, undoneOrder: ['retained'], doneOrder: [], versions: { 'todo.retained': 4, 'todo.index': 4 } });

describe('applyTodoSocketUpdates Account storage at the Home boundary', () => {
    let encryption: Awaited<ReturnType<typeof Encryption.create>>;
    let prior: ReturnType<typeof retainedState>;
    let publications: unknown[];
    let unsubscribe: (() => void) | undefined;
    let mutations: Array<{ key: string; value: string; version: number }>;

    const apply = (changes: KvSocketChange[], mode: 'plain' | 'e2ee' = 'plain') => applyTodoSocketUpdates({
        changes, credentials: mode === 'plain' ? plainCredentials : encryptedCredentials,
        encryption: mode === 'plain' ? null : encryption,
        request: requests[mode], invalidateTodosSync: vi.fn(),
    });

    beforeEach(async () => {
        network.resetRequests();
        encryption = await Encryption.create(LEGACY_SECRET_BYTES);
        prior = retainedState();
        storage.getState().applyTodos(prior);
        publications = [];
        unsubscribe = storage.subscribe((next, previous) => {
            if (next.todoState !== previous.todoState) publications.push(next.todoState);
        });
        mutations = [];
        network.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption/currentness') {
                return Response.json(url.origin === plainHome.serverUrl
                    ? createPlainAccountEncryptionCurrentnessFixture() : encryptedCurrentness);
            }
            if (url.pathname === '/v1/kv' && init?.method === 'POST') {
                // The HTTP fixture consumes the real client's published KV request shape.
                const parsed = JSON.parse(String(init.body)) as KvMutateRequest;
                // A read-triggered migration must preserve the complete legacy
                // JSON and use the real predecessor row revision for its CAS.
                const paired = await Encryption.createFromContentKeyPair({
                    machineKey: encryption.getContentPrivateKey(), publicKey: encryption.contentDataKey,
                });
                for (const row of parsed.mutations) {
                    expect(row.version).toBe(6);
                    const vector = legacyAccountKvVectors.find(vector => vector.key === row.key);
                    expect(vector).toBeDefined();
                    if (row.value === null) throw new Error('Expected a resealed legacy row');
                    await expect(paired.decryptRaw(row.value)).resolves.toEqual(vector!.value);
                    mutations.push({ ...row, value: row.value });
                }
                return Response.json({ success: true, results: parsed.mutations.map(row => ({ key: row.key, version: 7 })) });
            }
            return null;
        });
    });
    afterEach(() => { unsubscribe?.(); storage.setState({ todoState: null, todosLoaded: false }); });
    afterAll(async () => { await network.dispose(); });

    it('applies canonical plain KV envelopes without account encryption material', async () => {
        expect(plainCredentials).not.toHaveProperty('secret');
        expect(plainCredentials).not.toHaveProperty('encryption');
        await apply([
            { key: 'todo.item-1', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: item('Plain socket todo') }) },
            { key: 'todo.index', version: 1, value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain', v: { undoneOrder: ['item-1'], completedOrder: [] },
            }) },
        ]);
        expect(storage.getState().todoState).toEqual({
            todos: { ...prior.todos, 'item-1': item('Plain socket todo') }, undoneOrder: ['item-1'], doneOrder: [],
            versions: { ...prior.versions, 'todo.item-1': 1, 'todo.index': 1 },
        });
        expect(publications).toHaveLength(1);
        expect(mutations).toEqual([]);
    });

    it('re-seals legacy socket rows before applying the new storage revisions', async () => {
        await apply(legacyAccountKvVectors.map(row => ({ key: row.key, value: row.encoded, version: 6 })), 'e2ee');
        expect(storage.getState().todoState).toMatchObject({
            todos: { 'fx51-legacy': legacyAccountKvVectors[0].value },
            undoneOrder: ['fx51-legacy'], doneOrder: [],
            versions: { 'todo.fx51-legacy': 7, 'todo.index': 7 },
        });
        expect(mutations.map(row => row.key)).toEqual(['todo.fx51-legacy', 'todo.index']);
        expect(publications).toHaveLength(1);
    });

    it('preserves the current Todo state when encrypted socket data cannot be opened', async () => {
        await expect(apply([{ key: 'todo.item-1', version: 1, value: 'released-ciphertext' }]))
            .rejects.toBeInstanceOf(TodoStoredContentUnavailableError);
        expect(storage.getState().todoState).toBe(prior);
        expect(publications).toEqual([]);
        expect(mutations).toEqual([]);
    });

    it('rejects a malformed batch atomically without applying earlier valid changes', async () => {
        await expect(apply([
            { key: 'todo.item-1', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: item('Would be partial') }) },
            { key: 'todo.index', version: 2, value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain', v: { undoneOrder: 'invalid', completedOrder: [] },
            }) },
        ])).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable', key: 'todo.index', reason: 'schema_invalid',
        });
        expect(storage.getState().todoState).toBe(prior);
        expect(publications).toEqual([]);
        expect(mutations).toEqual([]);
    });

    it('surfaces ciphertext authentication failure as typed Todo unavailability', async () => {
        const validCiphertext = await encryption.encryptRaw(item('Authenticated task'));
        const bytes = decodeBase64(validCiphertext, 'base64');
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        await expect(apply([{ key: 'todo.item-1', version: 1, value: encodeBase64(bytes, 'base64') }], 'e2ee'))
            .rejects.toMatchObject({
                code: 'todo_stored_content_unavailable', key: 'todo.item-1', reason: 'content_unreadable',
            });
        expect(storage.getState().todoState).toBe(prior);
        expect(publications).toEqual([]);
        expect(mutations).toEqual([]);
    });

    it.each(['plain', 'e2ee'] as const)('refuses %s Account socket hydration from the opposite Todo envelope mode', async mode => {
        const value = mode === 'plain' ? await encryption.encryptRaw(item('Do not disclose'))
            : encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: item('Do not disclose') });
        await expect(apply([{ key: 'todo.item-1', version: 1, value }], mode)).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable', key: 'todo.item-1', reason: 'account_mode_mismatch',
        });
        expect(storage.getState().todoState).toBe(prior);
        expect(publications).toEqual([]);
        expect(mutations).toEqual([]);
    });
});
