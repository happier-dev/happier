import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createEncryptionFromAuthCredentials: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    serverFetch: vi.fn(),
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: mocks.createEncryptionFromAuthCredentials,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('fetchAndApplySessionOrganizationSnapshot', () => {
    beforeEach(async () => {
        mocks.createEncryptionFromAuthCredentials.mockReset();
        mocks.createEncryptionFromAuthCredentials.mockResolvedValue({
            getContentPrivateKey: () => new Uint8Array(32).fill(9),
        });
        mocks.fetchAccountEncryptionMode.mockReset();
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('opens encrypted display envelopes before applying snapshots', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: { name: 'Encrypted folder' },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            snapshot: {
                schemaVersion: 1,
                version: 43,
                pins: [],
                folders: [{
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        }));

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            request: { includeFolders: true },
        });

        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey['server-a:folder-a']?.display).toEqual({
            t: 'plain',
            v: { name: 'Encrypted folder' },
        });
    });

    it('does not apply a snapshot if the scope is cancelled after display envelopes are opened', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: { name: 'Stale folder' },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            snapshot: {
                schemaVersion: 1,
                version: 44,
                pins: [],
                folders: [{
                    folderId: 'folder-stale',
                    folderKey: 'folder-stale',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        }));
        let checks = 0;

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            request: { includeFolders: true },
            shouldContinue: () => {
                checks += 1;
                return checks === 1;
            },
        });

        expect(checks).toBeGreaterThanOrEqual(2);
        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey['server-a:folder-stale']).toBeUndefined();
    });
});
