import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@/encryption/base64';

const LEGACY_SECRET_BYTES = new Uint8Array(32).fill(7);
const LEGACY_SECRET = encodeBase64(LEGACY_SECRET_BYTES, 'base64url');
const LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(
            deriveAccountMachineKeyFromRecoverySecret(LEGACY_SECRET_BYTES),
        ).publicKey,
    );

const mocks = vi.hoisted(() => ({
    applyTodos: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(),
    kvGet: vi.fn(),
    kvList: vi.fn(),
    kvMutate: vi.fn(),
    kvSet: vi.fn(),
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
    randomUUID: vi.fn(() => 'todo-plain-1'),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode,
    fetchAccountEncryptionCurrentness: mocks.fetchAccountEncryptionCurrentness,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: mocks.getServerFeaturesSnapshot,
}));

vi.mock('@/sync/api/account/apiKv', () => ({
    kvGet: mocks.kvGet,
    kvBulkGet: vi.fn(),
    kvList: mocks.kvList,
    kvMutate: mocks.kvMutate,
    kvSet: mocks.kvSet,
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
    getSyncSingleton: () => ({ encryption: mocks.accountEncryption }),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: mocks.randomUUID,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => ({ credentials: { token: 'token-only' } }),
}));

import {
    addTodo,
    deleteTodo,
    fetchTodos,
    initializeTodoSync,
    reorderTodos,
    toggleTodo,
    updateTodoLinkedSessions,
    updateTodoTitle,
} from './todoOps';
import { TodoStoredContentUnavailableError } from './todoStoredContent';
import {
    decodeBase64StoredJsonContentEnvelope,
    encodeBase64StoredJsonContentEnvelope,
} from '@/sync/encryption/base64StoredJsonContent';

describe('todoOps plaintext account storage', () => {
    beforeEach(() => {
        mocks.applyTodos.mockReset();
        mocks.fetchAccountEncryptionMode.mockReset();
        mocks.fetchAccountEncryptionCurrentness.mockReset();
        mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 0,
        });
        mocks.kvGet.mockReset();
        mocks.kvList.mockReset();
        mocks.kvMutate.mockReset();
        mocks.kvSet.mockReset();
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
        mocks.randomUUID.mockClear();
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

        await expect(fetchTodos({ token: 'token-only' })).resolves.toEqual({
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

    it('retains the predecessor raw-ciphertext read path when encryption material exists', async () => {
        mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-current',
            contentKeyFingerprint: LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT,
            updatedAt: 0,
        });
        mocks.accountEncryption = {
            encryptRaw: vi.fn(),
            decryptRaw: vi.fn(async (encoded: string) => {
                if (encoded === 'raw-index') {
                    return {
                        undoneOrder: ['item-1'],
                        completedOrder: [],
                    };
                }
                return {
                    id: 'item-1',
                    title: 'Historical todo',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                };
            }),
        };
        mocks.kvList.mockResolvedValue({
            items: [
                { key: 'todo.item-1', value: 'raw-item', version: 2 },
                { key: 'todo.index', value: 'raw-index', version: 3 },
            ],
        });

        await expect(fetchTodos({
            token: 'token',
            secret: LEGACY_SECRET,
        })).resolves.toMatchObject({
            todos: {
                'item-1': { title: 'Historical todo' },
            },
            undoneOrder: ['item-1'],
        });
    });

    it('refuses E2EE Todo access when local credentials do not match Account key currentness', async () => {
        mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
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
            token: 'token',
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
            credentials: { token: 'token-only' },
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
            credentials: { token: 'token', secret: LEGACY_SECRET },
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
        mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
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

    it('preserves the legacy E2EE Todo writer without requiring marker capability', async () => {
        mocks.accountEncryption = {
            encryptRaw: vi.fn(async (value: unknown) =>
                `released-ciphertext:${JSON.stringify(value)}`),
            decryptRaw: vi.fn(),
        };
        mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-current',
            contentKeyFingerprint: LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT,
            updatedAt: 0,
        });
        mocks.kvGet.mockResolvedValue(null);
        mocks.kvMutate.mockResolvedValue({
            success: true,
            results: [
                { key: 'todo.todo-plain-1', version: 1 },
                { key: 'todo.index', version: 1 },
            ],
        });
        mocks.getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {},
            },
        });

        await expect(addTodo(
            { token: 'token', secret: LEGACY_SECRET },
            'Encrypted todo',
        )).resolves.toBe('todo-plain-1');

        expect(mocks.getServerFeaturesSnapshot).not.toHaveBeenCalled();
        expect(mocks.kvMutate).toHaveBeenCalledTimes(1);
    });

    it('writes todo and index values as canonical plain KV envelopes', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        mocks.kvGet.mockResolvedValue(null);
        mocks.kvMutate.mockResolvedValue({
            success: true,
            results: [
                { key: 'todo.todo-plain-1', version: 1 },
                { key: 'todo.index', version: 1 },
            ],
        });

        await expect(addTodo({ token: 'token-only' }, 'Plain todo')).resolves.toBe('todo-plain-1');

        const mutations = mocks.kvMutate.mock.calls[0]?.[1];
        expect(mutations).toHaveLength(2);
        expect(
            decodeBase64StoredJsonContentEnvelope(mutations[0].value),
        ).toMatchObject({
            t: 'plain',
            v: { id: 'todo-plain-1', title: 'Plain todo' },
        });
        expect(
            decodeBase64StoredJsonContentEnvelope(mutations[1].value),
        ).toEqual({
            t: 'plain',
            v: { undoneOrder: ['todo-plain-1'], completedOrder: [] },
        });
    });

    it('refuses plain Todo marker writes against an immutable old-server capability snapshot', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        mocks.getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    encryption: {
                        storagePolicy: 'optional',
                    },
                },
            },
        });
        mocks.kvGet.mockResolvedValue(null);

        await expect(addTodo({ token: 'token-only' }, 'Do not send')).rejects.toMatchObject({
            code: 'client-upgrade-required',
            retryable: false,
        });

        expect(mocks.kvMutate).not.toHaveBeenCalled();
        expect(mocks.kvSet).not.toHaveBeenCalled();
    });

    it('refuses plain Todo link writes against observe-only servers', async () => {
        mocks.todoState = {
            todos: {
                existing: {
                    id: 'existing',
                    title: 'Keep me',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                    linkedSessions: {},
                },
            },
            undoneOrder: ['existing'],
            doneOrder: [],
            versions: { 'todo.existing': 2 },
        };
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        mocks.getServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: 1,
                        currentProtocolVersion: 1,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            },
        });
        mocks.kvGet.mockResolvedValue({
            key: 'todo.existing',
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: mocks.todoState.todos.existing,
            }),
            version: 2,
        });

        await expect(updateTodoLinkedSessions('existing', {
            session: { title: 'Session', linkedAt: 2 },
        })).rejects.toMatchObject({
            code: 'client-upgrade-required',
            retryable: false,
        });

        expect(mocks.kvSet).not.toHaveBeenCalled();
        expect(mocks.kvMutate).not.toHaveBeenCalled();
    });

    it('does not misreport encrypted Todo storage as empty when key material is unavailable', async () => {
        mocks.kvList.mockResolvedValue({
            items: [{
                key: 'todo.item-1',
                value: 'released-ciphertext',
                version: 2,
            }],
        });

        await expect(fetchTodos({ token: 'token-only' })).rejects.toBeInstanceOf(
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

        await expect(fetchTodos({ token: 'token-only' })).rejects.toMatchObject({
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

        await expect(initializeTodoSync({ token: 'token-only' })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });
        expect(mocks.applyTodos).not.toHaveBeenCalled();
        expect(mocks.todoState).toBe(priorState);
    });

    it('does not write or retain an optimistic add when the authoritative index is unreadable', async () => {
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
                'todo.existing': 1,
                'todo.index': 4,
            },
        };
        mocks.todoState = priorState;
        mocks.kvGet.mockResolvedValue({
            key: 'todo.index',
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: { undoneOrder: ['existing'], completedOrder: false },
            }),
            version: 4,
        });

        await expect(addTodo({ token: 'token-only' }, 'Must not persist')).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });

        expect(mocks.kvMutate).not.toHaveBeenCalled();
        expect(mocks.todoState).toEqual(priorState);
    });

    it('refuses an optimistic mutation whose authoritative baseline envelope mismatches Account mode', async () => {
        const priorState = {
            todos: {},
            undoneOrder: [],
            doneOrder: [],
            versions: { 'todo.index': 4 },
        };
        mocks.todoState = priorState;
        mocks.accountEncryption = {
            encryptRaw: vi.fn(),
            decryptRaw: vi.fn(async () => ({
                undoneOrder: [],
                completedOrder: [],
            })),
        };
        mocks.kvGet.mockResolvedValue({
            key: 'todo.index',
            value: 'released-encrypted-ciphertext',
            version: 4,
        });

        await expect(addTodo(
            { token: 'token-only' },
            'Must not persist',
        )).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
            reason: 'account_mode_mismatch',
        });

        expect(mocks.kvMutate).not.toHaveBeenCalled();
        expect(mocks.todoState).toEqual(priorState);
    });

    it('fails closed across item and index mutation paths when their server baselines are unreadable', async () => {
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
        const malformedItem = {
            key: 'todo.existing',
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: { id: 'existing', title: 'Unreadable' },
            }),
            version: 2,
        };
        const validIndex = {
            key: 'todo.index',
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: { undoneOrder: ['existing'], completedOrder: [] },
            }),
            version: 4,
        };
        const malformedIndex = {
            ...validIndex,
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: { undoneOrder: null, completedOrder: [] },
            }),
        };

        for (const mutate of [
            () => updateTodoTitle({ token: 'token-only' }, 'existing', 'Changed'),
            () => toggleTodo({ token: 'token-only' }, 'existing'),
            () => updateTodoLinkedSessions('existing', {
                session: { title: 'Session', linkedAt: 2 },
            }),
            () => deleteTodo({ token: 'token-only' }, 'existing'),
        ]) {
            mocks.todoState = priorState;
            mocks.kvGet.mockImplementation(async (_credentials: unknown, key: string) =>
                key === 'todo.index' ? validIndex : malformedItem
            );

            await expect(mutate()).rejects.toMatchObject({
                code: 'todo_stored_content_unavailable',
                key: 'todo.existing',
            });
            expect(mocks.todoState).toEqual(priorState);
        }

        mocks.todoState = priorState;
        mocks.kvGet.mockResolvedValue(malformedIndex);
        await expect(
            reorderTodos({ token: 'token-only' }, 'existing', 0, 'undone'),
        ).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });

        expect(mocks.kvSet).not.toHaveBeenCalled();
        expect(mocks.kvMutate).not.toHaveBeenCalled();
        expect(mocks.todoState).toEqual(priorState);
    });
});
