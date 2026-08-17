import { describe, expect, it, vi } from 'vitest';
import {
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

const { applyTodos, fetchAccountEncryptionCurrentness } = vi.hoisted(() => ({
    applyTodos: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionCurrentness,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            todoState: {
                todos: {},
                undoneOrder: [],
                doneOrder: [],
                versions: {},
            },
            applyTodos,
        }),
    },
}));

import { beforeEach } from 'vitest';
import { applyTodoSocketUpdates } from './syncTodos';
import { TodoStoredContentUnavailableError } from '@/sync/domains/todos/todoStoredContent';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';

describe('applyTodoSocketUpdates plaintext account storage', () => {
    beforeEach(() => {
        applyTodos.mockReset();
        fetchAccountEncryptionCurrentness.mockReset();
        fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 0,
        });
    });

    it('applies canonical plain KV envelopes without account encryption material', async () => {
        await applyTodoSocketUpdates({
            changes: [
                {
                    key: 'todo.item-1',
                    version: 1,
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: {
                            id: 'item-1',
                            title: 'Plain socket todo',
                            done: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    }),
                },
                {
                    key: 'todo.index',
                    version: 1,
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: { undoneOrder: ['item-1'], completedOrder: [] },
                    }),
                },
            ],
            encryption: null,
            credentials: { token: 'token-only' },
            invalidateTodosSync: vi.fn(),
        });

        expect(applyTodos).toHaveBeenCalledWith({
            todos: {
                'item-1': expect.objectContaining({ title: 'Plain socket todo' }),
            },
            undoneOrder: ['item-1'],
            doneOrder: [],
            versions: {
                'todo.item-1': 1,
                'todo.index': 1,
            },
        });
    });

    it('preserves the current Todo state when encrypted socket data cannot be opened', async () => {
        await expect(applyTodoSocketUpdates({
            changes: [{
                key: 'todo.item-1',
                version: 1,
                value: 'released-ciphertext',
            }],
            encryption: null,
            credentials: { token: 'token-only' },
            invalidateTodosSync: vi.fn(),
        })).rejects.toBeInstanceOf(
            TodoStoredContentUnavailableError,
        );
        expect(applyTodos).not.toHaveBeenCalled();
    });

    it('rejects a malformed batch atomically without applying earlier valid changes', async () => {
        await expect(applyTodoSocketUpdates({
            changes: [
                {
                    key: 'todo.item-1',
                    version: 1,
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: {
                            id: 'item-1',
                            title: 'Would be partial',
                            done: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    }),
                },
                {
                    key: 'todo.index',
                    version: 2,
                    value: encodeBase64StoredJsonContentEnvelope({
                        t: 'plain',
                        v: { undoneOrder: 'invalid', completedOrder: [] },
                    }),
                },
            ],
            encryption: null,
            credentials: { token: 'token-only' },
            invalidateTodosSync: vi.fn(),
        })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });

        expect(applyTodos).not.toHaveBeenCalled();
    });

    it('surfaces ciphertext authentication failure as typed Todo unavailability', async () => {
        fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-current',
            contentKeyFingerprint: LEGACY_ACCOUNT_MIGRATION_KEY_FINGERPRINT,
            updatedAt: 0,
        });
        await expect(applyTodoSocketUpdates({
            changes: [{
                key: 'todo.item-1',
                version: 1,
                value: 'released-ciphertext',
            }],
            encryption: {
                decryptRaw: vi.fn(async () => {
                    throw new Error('authentication failed');
                }),
            },
            credentials: { token: 'token', secret: LEGACY_SECRET },
            invalidateTodosSync: vi.fn(),
        })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.item-1',
            reason: 'content_unreadable',
        });
        expect(applyTodos).not.toHaveBeenCalled();
    });

    it.each([
        {
            accountMode: 'plain' as const,
            value: 'released-encrypted-ciphertext',
            credentials: { token: 'token-only' },
            encryption: {
                decryptRaw: vi.fn(async () => ({
                    id: 'item-1',
                    title: 'Do not disclose',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                })),
            },
        },
        {
            accountMode: 'e2ee' as const,
            value: encodeBase64StoredJsonContentEnvelope({
                t: 'plain',
                v: {
                    id: 'item-1',
                    title: 'Do not disclose',
                    done: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            }),
            credentials: { token: 'token', secret: LEGACY_SECRET },
            encryption: { decryptRaw: vi.fn() },
        },
    ])('refuses $accountMode Account socket hydration from the opposite Todo envelope mode', async ({
        accountMode,
        value,
        credentials,
        encryption,
    }) => {
        fetchAccountEncryptionCurrentness.mockResolvedValue({
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

        await expect(applyTodoSocketUpdates({
            changes: [{ key: 'todo.item-1', version: 1, value }],
            encryption,
            credentials,
            invalidateTodosSync: vi.fn(),
        })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.item-1',
            reason: 'account_mode_mismatch',
        });
        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applyTodos).not.toHaveBeenCalled();
    });
});
