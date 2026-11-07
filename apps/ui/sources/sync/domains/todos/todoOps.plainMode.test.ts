import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { legacyAccountKvVectors } from '../../../../../../packages/protocol/src/crypto/fixtures/accountKvLegacyV0';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { ServerFetch } from '@/sync/http/client';

const LEGACY_SECRET_BYTES = new Uint8Array(32).fill(7);
const LEGACY_SECRET = encodeBase64(LEGACY_SECRET_BYTES, 'base64url');
const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'todo-account' })).toString('base64url')}.signature`;
const unknownTasksRoute = () => Response.json({ statusCode: 404, error: 'Not Found', message: 'Route GET:/v1/tasks not found' }, { status: 404 });
const LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(
            deriveAccountMachineKeyFromRecoverySecret(LEGACY_SECRET_BYTES),
        ).publicKey,
    );

const mocks = vi.hoisted(() => ({
    applyTodos: vi.fn(),
    currentnessHttp: vi.fn<() => Promise<unknown>>(),
    kvGet: vi.fn(),
    kvList: vi.fn(),
    kvMutate: vi.fn(),
    getServerFeaturesSnapshot: vi.fn(),
    accountEncryption: null as null | {
        encryptRaw: (value: unknown) => Promise<string>;
        decryptRaw: (value: string) => Promise<unknown>;
    },
    todoState: {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {},
    } as {
        todos: Record<string, unknown>;
        undoneOrder: string[];
        doneOrder: string[];
        versions: Record<string, number>;
    },
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: mocks.getServerFeaturesSnapshot,
}));

vi.mock('@/sync/api/account/apiKv', () => ({
    kvGet: mocks.kvGet,
    kvBulkGet: vi.fn(),
    kvList: mocks.kvList,
    kvMutate: mocks.kvMutate,
    kvDelete: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            todoState: mocks.todoState,
            applyTodos: (next: typeof mocks.todoState) => {
                mocks.todoState = next;
                mocks.applyTodos(next);
            },
        }),
    },
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ encryption: mocks.accountEncryption,
        getCredentials: () => ({ token: TOKEN, secret: LEGACY_SECRET }) }),
}));

import {
    fetchTodos,
    initializeTodoSync,
    reorderTodos,
} from './todoOps';
import { TodoStoredContentUnavailableError } from './todoStoredContent';
import {
    encodeBase64StoredJsonContentEnvelope,
} from '@/sync/encryption/base64StoredJsonContent';

describe('todoOps plaintext account storage', () => {
    afterEach(() => resetRuntimeFetch());
    beforeEach(() => {
        mocks.applyTodos.mockReset();
        mocks.currentnessHttp.mockReset();
        mocks.currentnessHttp.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 0,
        });
        // Replace Home HTTP only; the strict mode parser and material admission
        // remain real so unavailable/mismatch tests cannot pass on missing mocks.
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(await mocks.currentnessHttp());
            if (path === '/v1/tasks') return unknownTasksRoute();
            return new Response(null, { status: 404 });
        });
        mocks.kvGet.mockReset();
        mocks.kvList.mockReset();
        mocks.kvMutate.mockReset();
        mocks.getServerFeaturesSnapshot.mockReset();
        mocks.getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion:
                            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion:
                            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            },
        });
        mocks.accountEncryption = null;
        mocks.todoState = {
            todos: {},
            undoneOrder: [],
            doneOrder: [],
            versions: {},
        };
    });

    it('reads canonical plain KV envelopes without account encryption material', async () => {
        mocks.kvList.mockResolvedValue({
            items: [
                {
                    key: 'todo.item-1',
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: {
                            id: 'item-1',
                            title: 'Plain todo',
                            done: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    }),
                    version: 2,
                },
                {
                    key: 'todo.index',
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: { undoneOrder: ['item-1'], completedOrder: [] },
                    }),
                    version: 3,
                },
            ],
        });

        await expect(fetchTodos({ token: TOKEN })).resolves.toEqual({
            todos: {
                'item-1': expect.objectContaining({ title: 'Plain todo' }),
            },
            undoneOrder: ['item-1'],
            doneOrder: [],
            versions: {
                'todo.item-1': 2,
                'todo.index': 3,
            },
        });
    });

    it('loads all Tasks and the index across the KV page boundary before reconciling order', async () => {
        const item = (id: string) => ({ key: `todo.${id}`, version: 2,
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: {
                id, title: id, done: false, createdAt: 1, updatedAt: 1,
                linkedSessions: id === 'z-last' ? { session: { title: 'Linked session', linkedAt: 1 } } : {},
            } }) });
        const first = Array.from({ length: 1000 }, (_, n) => item(`a-${String(n).padStart(4, '0')}`));
        mocks.kvList.mockResolvedValueOnce({ items: first }).mockResolvedValueOnce({ items: [
            { key: 'todo.index', version: 3, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: {
                undoneOrder: ['z-last', ...first.map(row => row.key.slice('todo.'.length))], completedOrder: [],
            } }) }, item('z-last'),
        ] });
        const request = vi.fn<ServerFetch>(async path => path === '/v1/tasks' ? unknownTasksRoute() : Response.json(await mocks.currentnessHttp()));
        const state = await fetchTodos({ token: TOKEN }, { retry: 'none', request });
        expect(Object.keys(state.todos)).toHaveLength(1001);
        expect(state.undoneOrder[0]).toBe('z-last');
        expect(state.todos['z-last']?.linkedSessions).toEqual({ session: { title: 'Linked session', linkedAt: 1 } });
        expect(state.versions['todo.index']).toBe(3);
        expect(mocks.kvList).toHaveBeenLastCalledWith({ token: TOKEN }, expect.objectContaining({
            afterKey: 'todo.a-0999', limit: 1000, retry: 'none', request,
        }));
    });

    it('preserves hydrated Tasks when a later refresh page fails instead of publishing partial acquisition', async () => {
        const prior = { todos: { retained: { id: 'retained', title: 'Retained', done: false, createdAt: 1, updatedAt: 1 } },
            undoneOrder: ['retained'], doneOrder: [], versions: { 'todo.retained': 1 } };
        mocks.todoState = prior;
        const item = (id: string) => ({ key: `todo.${id}`, version: 1,
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: {
                id, title: 'Keep', done: false, createdAt: 1, updatedAt: 1,
            } }) });
        mocks.kvList.mockResolvedValueOnce({ items: Array.from({ length: 1000 }, (_, n) => item(`a-${String(n).padStart(4, '0')}`)) })
            .mockRejectedValueOnce(new Error('later page unavailable'));
        await expect(initializeTodoSync({ token: TOKEN })).rejects.toThrow('later page unavailable');
        expect(mocks.todoState).toBe(prior);
        expect(mocks.applyTodos).not.toHaveBeenCalled();
    });

    it('opens and lazily re-seals real predecessor item/index shapes before Todo projection', async () => {
        mocks.currentnessHttp.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-current',
            contentKeyFingerprint: LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT,
            updatedAt: 0,
        });
        const encryption = await Encryption.create(LEGACY_SECRET_BYTES);
        mocks.accountEncryption = encryption;
        mocks.kvList.mockResolvedValue({
            items: legacyAccountKvVectors.map(row => ({ key: row.key, value: row.encoded, version: 6 })),
        });
        const paired = await Encryption.createFromContentKeyPair({ publicKey: encryption.contentDataKey, machineKey: encryption.getContentPrivateKey() });
        mocks.kvMutate.mockImplementation(async (_credentials, rows: { key: string; value: string; version: number }[]) => {
            const row = rows[0]!;
            expect(row.version).toBe(6);
            await expect(paired.decryptRaw(row.value)).resolves.toEqual(legacyAccountKvVectors.find(fixture => fixture.key === row.key)!.value);
            return { success: true, results: [{ key: row.key, version: 7 }] };
        });

        await expect(fetchTodos({
            token: TOKEN,
            secret: LEGACY_SECRET,
        })).resolves.toMatchObject({
            todos: {
                'fx51-legacy': { title: 'QA FX51 synthetic legacy task' },
            },
            undoneOrder: ['fx51-legacy'],
            versions: { 'todo.fx51-legacy': 7, 'todo.index': 7 },
        });
    });

    it('refuses E2EE Todo access when local credentials do not match Account key currentness', async () => {
        mocks.currentnessHttp.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-current',
            contentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    new Uint8Array(32).fill(9),
                ),
            updatedAt: 0,
        });
        mocks.accountEncryption = {
            encryptRaw: vi.fn(),
            decryptRaw: vi.fn(),
        };

        await expect(fetchTodos({
            token: TOKEN,
            secret: LEGACY_SECRET,
        })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
            reason: 'account_currentness_unavailable',
        });
        expect(mocks.kvList).not.toHaveBeenCalled();
        expect(mocks.accountEncryption.decryptRaw).not.toHaveBeenCalled();
    });

    it.each([
        {
            accountMode: 'plain' as const,
            value: 'released-encrypted-ciphertext',
            credentials: { token: TOKEN },
            encryption: {
                encryptRaw: vi.fn(),
                decryptRaw: vi.fn(async () => ({
                    undoneOrder: [],
                    completedOrder: [],
                })),
            },
        },
        {
            accountMode: 'e2ee' as const,
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: { undoneOrder: [], completedOrder: [] },
            }),
            credentials: { token: TOKEN, secret: LEGACY_SECRET },
            encryption: {
                encryptRaw: vi.fn(),
                decryptRaw: vi.fn(),
            },
        },
    ])('refuses $accountMode Account reads whose Todo envelope has the opposite mode', async ({
        accountMode,
        value,
        credentials,
        encryption,
    }) => {
        mocks.currentnessHttp.mockResolvedValue({
            mode: accountMode,
            version: 1,
            signingKeyFingerprint:
                accountMode === 'e2ee' ? 'signing-current' : null,
            contentKeyFingerprint:
                accountMode === 'e2ee'
                    ? LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT
                    : null,
            updatedAt: 0,
        });
        mocks.accountEncryption = encryption;
        mocks.kvList.mockResolvedValue({
            items: [{ key: 'todo.index', value, version: 4 }],
        });

        await expect(fetchTodos(credentials)).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
            reason: 'account_mode_mismatch',
        });
        expect(encryption.decryptRaw).not.toHaveBeenCalled();
    });

    it('does not misreport encrypted Todo storage as empty when key material is unavailable', async () => {
        mocks.kvList.mockResolvedValue({
            items: [{
                key: 'todo.item-1',
                value: 'released-ciphertext',
                version: 2,
            }],
        });

        await expect(fetchTodos({ token: TOKEN })).rejects.toBeInstanceOf(
            TodoStoredContentUnavailableError,
        );
    });

    it('returns a typed unavailable failure for a malformed authoritative Todo item', async () => {
        mocks.kvList.mockResolvedValue({
            items: [{
                key: 'todo.item-1',
                value: encodeBase64StoredJsonContentEnvelope({
                    t: 'plain',
                    v: { id: 'item-1', title: 42 },
                }),
                version: 2,
            }],
        });

        await expect(fetchTodos({ token: TOKEN })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.item-1',
        });
    });

    it('preserves the prior state when initialization encounters a malformed authoritative index', async () => {
        const priorState = {
            todos: {
                existing: {
                    id: 'existing',
                    title: 'Keep me',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            undoneOrder: ['existing'],
            doneOrder: [],
            versions: { 'todo.existing': 1 },
        };
        mocks.todoState = priorState;
        mocks.kvList.mockResolvedValue({
            items: [{
                key: 'todo.index',
                value: encodeBase64StoredJsonContentEnvelope({
                    t: 'plain',
                    v: { undoneOrder: 'not-an-array', completedOrder: [] },
                }),
                version: 2,
            }],
        });

        await expect(initializeTodoSync({ token: TOKEN })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });
        expect(mocks.applyTodos).not.toHaveBeenCalled();
        expect(mocks.todoState).toBe(priorState);
    });

    it('fails closed when the authoritative reorder index is unreadable', async () => {
        const priorState = {
            todos: {
                existing: {
                    id: 'existing',
                    title: 'Keep me',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            undoneOrder: ['existing'],
            doneOrder: [],
            versions: {
                'todo.existing': 2,
                'todo.index': 4,
            },
        };
        mocks.todoState = priorState;
        mocks.kvGet.mockResolvedValue({
            key: 'todo.index',
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { undoneOrder: null, completedOrder: [] } }),
            version: 4,
        });
        await expect(
            reorderTodos({ token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature` }, 'existing', { anchorId: null, placement: 'before' }),
        ).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });

        expect(mocks.kvMutate).not.toHaveBeenCalled();
        expect(mocks.todoState).toEqual(priorState);
    });
});
