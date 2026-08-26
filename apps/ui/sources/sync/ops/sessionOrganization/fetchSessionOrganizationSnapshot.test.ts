import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createEncryptionFromAuthCredentials: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    resolveServerProfileScopeIdForIdentifier: vi.fn(),
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    resolveServerProfileScopeIdForIdentifier: mocks.resolveServerProfileScopeIdForIdentifier,
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
        mocks.resolveServerProfileScopeIdForIdentifier.mockReset();
        mocks.resolveServerProfileScopeIdForIdentifier.mockImplementation((serverId: string) => serverId);
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
        getStorage().getState().clearSessionOrganizationForServer('server-a-before-identity');
    });

    it('applies scoped snapshot data and marks missing requested assignments as unassigned', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            snapshot: {
                schemaVersion: 1,
                version: 42,
                pins: [{ sessionId: 's1', sortKey: 'rank-a', pinnedAt: 10 }],
                folders: [],
                folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
                tags: [],
                tagAssignments: [{ sessionId: 's1', tagIds: ['tag-a'] }],
                orderEntries: [],
                labels: [],
            },
        }));

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            request: {
                includeFolders: false,
                includeTags: false,
                includeLabels: false,
                assignmentSessionIds: ['s1', 's2'],
            },
        });

        const state = getStorage().getState();
        expect(state.sessionOrganizationPinsBySessionKey['server-a:s1']?.sortKey).toBe('rank-a');
        expect(state.sessionFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': 'folder-a',
            'server-a:s2': null,
        });
        expect(state.sessionOrganizationTagAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': ['tag-a'],
            'server-a:s2': [],
        });
        expect(state.sessionOrganizationLoadingByServerId['server-a']).toBe(false);
    });

    it('opens encrypted display envelopes before applying snapshots', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: {
                name: 'Encrypted folder',
                workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
            },
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
            request: {
                includeFolders: true,
            },
        });

        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey['server-a:folder-a']?.display).toEqual({
            t: 'plain',
            v: {
                name: 'Encrypted folder',
                workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
            },
        });
    });

    it('applies an in-flight snapshot under the current profile scope after server identity discovery', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        let resolvedServerId = 'server-a-before-identity';
        mocks.resolveServerProfileScopeIdForIdentifier.mockImplementation(() => resolvedServerId);
        mocks.serverFetch.mockImplementationOnce(async () => {
            resolvedServerId = 'server-a';
            return jsonResponse({
                snapshot: {
                    schemaVersion: 1,
                    version: 44,
                    pins: [],
                    folders: [{
                        folderId: 'folder-after-identity',
                        folderKey: 'folder-after-identity',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: null,
                        display: { t: 'plain', v: { name: 'After identity' } },
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
            });
        });

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a-before-identity',
            request: { includeFolders: true },
        });

        const state = getStorage().getState();
        expect(state.sessionOrganizationFoldersByFolderKey['server-a:folder-after-identity']).toBeDefined();
        expect(state.sessionOrganizationFoldersByFolderKey['server-a-before-identity:folder-after-identity']).toBeUndefined();
        expect(state.sessionOrganizationLoadingByServerId['server-a-before-identity']).toBe(false);
        expect(state.sessionOrganizationLoadingByServerId['server-a']).toBe(false);
    });

    it('does not apply a snapshot if the scope is cancelled after display envelopes are opened', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: {
                name: 'Stale folder',
                workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
            },
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
            request: {
                includeFolders: true,
            },
            shouldContinue: () => {
                checks += 1;
                return checks === 1;
            },
        });

        expect(checks).toBeGreaterThanOrEqual(2);
        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey['server-a:folder-stale']).toBeUndefined();
    });
});
