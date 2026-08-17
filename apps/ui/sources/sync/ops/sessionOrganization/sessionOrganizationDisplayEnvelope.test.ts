import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createEncryptionFromAuthCredentials: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: mocks.createEncryptionFromAuthCredentials,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode,
}));

const credentials = { token: 'token-a', secret: 'secret-a' };
const machineKey = new Uint8Array(32).fill(7);

describe('session organization display envelopes', () => {
    beforeEach(() => {
        mocks.createEncryptionFromAuthCredentials.mockReset();
        mocks.createEncryptionFromAuthCredentials.mockResolvedValue({
            getContentPrivateKey: () => machineKey,
        });
        mocks.fetchAccountEncryptionMode.mockReset();
    });

    it('keeps display payloads plain for plain-storage accounts', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValueOnce({ mode: 'plain', updatedAt: 0 });
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');

        await expect(prepareSessionOrganizationDisplayEnvelope({
            credentials,
            value: { label: 'Project A' },
        })).resolves.toEqual({ t: 'plain', v: { label: 'Project A' } });
        expect(mocks.createEncryptionFromAuthCredentials).not.toHaveBeenCalled();
    });

    it.each([
        ['undefined', undefined],
        ['function', () => undefined],
        ['symbol', Symbol('organization')],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['BigInt', 1n],
    ])('rejects a non-JSON plain %s value before returning a write envelope', async (_label, value) => {
        mocks.fetchAccountEncryptionMode.mockResolvedValueOnce({ mode: 'plain', updatedAt: 0 });
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');

        await expect(prepareSessionOrganizationDisplayEnvelope({
            credentials,
            value,
        })).rejects.toThrow();
        expect(mocks.createEncryptionFromAuthCredentials).not.toHaveBeenCalled();
    });

    it('preserves retained encrypted display payloads when token-only credentials have no account key', async () => {
        const {
            openSessionOrganizationDisplayEnvelope,
            openSessionOrganizationSnapshotDisplayEnvelopes,
        } = await import('./sessionOrganizationDisplayEnvelope');
        const tokenOnlyCredentials = { token: 'token-only' };
        const encryptedDisplay = { t: 'encrypted' as const, c: 'retained-ciphertext' };

        await expect(openSessionOrganizationDisplayEnvelope({
            credentials: tokenOnlyCredentials,
            envelope: encryptedDisplay,
        })).resolves.toEqual({
            envelope: encryptedDisplay,
            displayState: {
                status: 'locked',
                reason: 'account_key_unavailable',
            },
        });
        await expect(openSessionOrganizationSnapshotDisplayEnvelopes({
            credentials: tokenOnlyCredentials,
            snapshot: {
                schemaVersion: 1,
                version: 1,
                pins: [{
                    sessionId: 'session-1',
                    sortKey: null,
                    pinnedAt: 1,
                }],
                folders: [{
                    folderId: 'folder-1',
                    folderKey: 'folder-1',
                    parentFolderId: null,
                    parentFolderKey: null,
                    display: encryptedDisplay,
                    sortKey: null,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                folderAssignments: [{
                    sessionId: 'session-1',
                    folderId: 'folder-1',
                }],
                tags: [{
                    tagId: 'tag-1',
                    tagKey: 'private/tag/key',
                    sortKey: null,
                    display: encryptedDisplay,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                tagAssignments: [{
                    sessionId: 'session-1',
                    tagIds: ['tag-1'],
                }],
                orderEntries: [{
                    scopeKind: 'group',
                    scopeKey: 'group-1',
                    itemKind: 'folder',
                    itemKey: 'folder-1',
                    sortKey: '0001',
                }],
                labels: [{
                    labelKind: 'workspace',
                    scopeKey: 'private/workspace/key',
                    display: encryptedDisplay,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        })).resolves.toMatchObject({
            pins: [{ sessionId: 'session-1' }],
            folders: [{
                folderId: 'folder-1',
                display: encryptedDisplay,
                displayState: {
                    status: 'locked',
                    reason: 'account_key_unavailable',
                },
            }],
            folderAssignments: [{
                sessionId: 'session-1',
                folderId: 'folder-1',
            }],
            tags: [{
                tagId: 'tag-1',
                display: encryptedDisplay,
                displayState: {
                    status: 'locked',
                    reason: 'account_key_unavailable',
                },
            }],
            tagAssignments: [{
                sessionId: 'session-1',
                tagIds: ['tag-1'],
            }],
            orderEntries: [{
                itemKind: 'folder',
                itemKey: 'folder-1',
            }],
            labels: [{
                labelKind: 'workspace',
                scopeKey: 'private/workspace/key',
                display: encryptedDisplay,
                displayState: {
                    status: 'locked',
                    reason: 'account_key_unavailable',
                },
            }],
        });
        expect(mocks.createEncryptionFromAuthCredentials).not.toHaveBeenCalled();
    });

    it('retains a wrong-key or malformed encrypted display as explicitly unreadable', async () => {
        const {
            openSessionOrganizationDisplayEnvelope,
        } = await import('./sessionOrganizationDisplayEnvelope');
        const encryptedDisplay = {
            t: 'encrypted' as const,
            c: 'not-an-account-scoped-ciphertext',
        };

        await expect(openSessionOrganizationDisplayEnvelope({
            credentials,
            envelope: encryptedDisplay,
        })).resolves.toEqual({
            envelope: encryptedDisplay,
            displayState: {
                status: 'locked',
                reason: 'content_unreadable',
            },
        });
    });

    it('preserves server-declared unavailable display state without treating a null envelope as readable', async () => {
        const {
            openSessionOrganizationFolderDisplay,
            openSessionOrganizationSnapshotDisplayEnvelopes,
        } = await import('./sessionOrganizationDisplayEnvelope');
        const folder = {
            folderId: 'folder-locked',
            folderKey: 'private/folder/key',
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: null,
            display: null,
            displayState: {
                status: 'unavailable' as const,
                reason: 'storage_mode_mismatch' as const,
            },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 1,
        };

        await expect(openSessionOrganizationFolderDisplay({
            credentials,
            folder,
        })).resolves.toMatchObject({
            folderId: 'folder-locked',
            display: null,
            displayState: {
                status: 'locked',
                reason: 'storage_mode_mismatch',
            },
        });
        await expect(openSessionOrganizationSnapshotDisplayEnvelopes({
            credentials,
            snapshot: {
                schemaVersion: 1,
                version: 1,
                pins: [],
                folders: [folder],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        })).resolves.toMatchObject({
            folders: [{
                folderId: 'folder-locked',
                displayState: {
                    status: 'locked',
                    reason: 'storage_mode_mismatch',
                },
            }],
        });
        expect(mocks.createEncryptionFromAuthCredentials).not.toHaveBeenCalled();
    });

    it('builds an exact future-mode migration directive without consulting the current server mode', async () => {
        const {
            buildSessionOrganizationAccountEncryptionMigrationDirective,
            openSessionOrganizationDisplayEnvelope,
        } = await import('./sessionOrganizationDisplayEnvelope');
        const inventory = {
            version: 14,
            folders: [{
                folderId: 'folder-active',
                display: { t: 'plain' as const, v: { name: 'Active' } },
            }],
            tags: [{
                tagId: 'tag-archived',
                display: { t: 'plain' as const, v: { label: 'Archived' } },
            }],
            labels: [{
                labelKind: 'workspace' as const,
                scopeKey: 'private/workspace/key',
                display: { t: 'plain' as const, v: { label: 'Workspace' } },
            }],
        };

        const directive = await buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory,
            sourceCredentials: credentials,
            targetCredentials: credentials,
            toMode: 'e2ee',
        });

        expect(directive).toMatchObject({
            action: 'migrate',
            expectedVersion: 14,
            folders: [{
                folderId: 'folder-active',
                expectedDisplay: { t: 'plain', v: { name: 'Active' } },
                display: { t: 'encrypted' },
            }],
            tags: [{
                tagId: 'tag-archived',
                expectedDisplay: { t: 'plain', v: { label: 'Archived' } },
                display: { t: 'encrypted' },
            }],
            labels: [{
                labelKind: 'workspace',
                scopeKey: 'private/workspace/key',
                expectedDisplay: { t: 'plain', v: { label: 'Workspace' } },
                display: { t: 'encrypted' },
            }],
        });
        expect(mocks.fetchAccountEncryptionMode).not.toHaveBeenCalled();
        if (directive.action !== 'migrate') throw new Error('Expected migration directive');
        await expect(openSessionOrganizationDisplayEnvelope({
            credentials,
            envelope: directive.folders[0]!.display,
        })).resolves.toMatchObject({
            displayState: {
                status: 'available',
                value: { name: 'Active' },
            },
        });
    });

    it('rejects an inventory that does not match the implied source mode', async () => {
        const {
            buildSessionOrganizationAccountEncryptionMigrationDirective,
        } = await import('./sessionOrganizationDisplayEnvelope');

        await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory: {
                version: 1,
                folders: [{
                    folderId: 'folder-plain',
                    display: { t: 'plain', v: { name: 'Already plain' } },
                }],
                tags: [],
                labels: [],
            },
            sourceCredentials: credentials,
            targetCredentials: null,
            toMode: 'plain',
        })).rejects.toThrow('source mode');
        expect(mocks.fetchAccountEncryptionMode).not.toHaveBeenCalled();
    });

    it('seals display payloads for e2ee accounts and opens them back to plain envelopes', async () => {
        mocks.fetchAccountEncryptionMode.mockResolvedValueOnce({ mode: 'e2ee', updatedAt: 0 });
        const {
            openSessionOrganizationDisplayEnvelope,
            prepareSessionOrganizationDisplayEnvelope,
        } = await import('./sessionOrganizationDisplayEnvelope');

        const sealed = await prepareSessionOrganizationDisplayEnvelope({
            credentials,
            value: { label: 'Secret Project' },
        });

        expect(sealed.t).toBe('encrypted');
        expect(sealed).not.toHaveProperty('v');
        await expect(openSessionOrganizationDisplayEnvelope({
            credentials,
            envelope: sealed,
        })).resolves.toEqual({
            envelope: sealed,
            displayState: {
                status: 'available',
                value: { label: 'Secret Project' },
            },
        });
    });
});
