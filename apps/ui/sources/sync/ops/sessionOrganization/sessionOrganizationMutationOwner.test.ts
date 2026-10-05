import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionFolderV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

const mocks = vi.hoisted(() => ({
    deleteSessionOrganizationFolder: vi.fn(),
    deleteSessionOrganizationLabel: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
    setSessionOrganizationPin: vi.fn(),
    upsertSessionOrganizationFolder: vi.fn(),
    upsertSessionOrganizationLabel: vi.fn(),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
        },
    });
});

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const { createAccountEncryptionModeModuleMock } = await import('@/dev/testkit/mocks/accountEncryptionMode');
    return await createAccountEncryptionModeModuleMock({
        importOriginal,
        overrides: { fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode },
    });
});

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        deleteSessionOrganizationFolder: mocks.deleteSessionOrganizationFolder,
        deleteSessionOrganizationLabel: mocks.deleteSessionOrganizationLabel,
        setSessionPin: mocks.setSessionOrganizationPin,
        upsertSessionOrganizationFolder: mocks.upsertSessionOrganizationFolder,
        upsertSessionOrganizationLabel: mocks.upsertSessionOrganizationLabel,
    };
});

const credentials = { token: 'token-a', secret: 'secret-a' };

function folder(params: Readonly<{
    id: string;
    name: string;
    parentId?: string | null;
    sortKey?: string;
}>): SessionFolderV1 {
    return {
        id: params.id,
        workspace: {
            t: 'workspaceScope',
            serverId: 'srv_current_identity',
            machineId: 'machine-a',
            rootPath: '/repo',
        },
        parentId: params.parentId ?? null,
        name: params.name,
        createdAt: 1,
        updatedAt: 1,
        ...(params.sortKey ? { sortKey: params.sortKey } : {}),
    };
}

function folders(...entries: SessionFolderV1[]): SessionFoldersV1 {
    return { v: 1, folders: entries };
}

describe('sessionOrganizationMutationOwner', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `session-organization-owner-${Math.random()}`;
        mocks.deleteSessionOrganizationFolder.mockReset();
        mocks.deleteSessionOrganizationLabel.mockReset();
        mocks.fetchAccountEncryptionMode.mockReset();
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        mocks.getCredentialsForServerUrl.mockReset();
        mocks.setSessionOrganizationPin.mockReset();
        mocks.upsertSessionOrganizationFolder.mockReset();
        mocks.upsertSessionOrganizationLabel.mockReset();
    });

    it('keeps the established Home identity canonical when a conflicting identity is rejected', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_old_identity');
        await expect(profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_current_identity'))
            .resolves.toBeNull();
        mocks.getCredentialsForServerUrl.mockResolvedValue(credentials);
        const { resolveSessionOrganizationMutationScope } = await import('./sessionOrganizationMutationOwner');

        const result = await resolveSessionOrganizationMutationScope('srv_old_identity');

        expect(result).toEqual({
            ok: true,
            scope: {
                credentials,
                serverId: 'srv_old_identity',
                serverIdAliases: [created.id],
                serverUrl: 'https://relay.example.test',
            },
        });
        expect(mocks.getCredentialsForServerUrl).toHaveBeenCalledWith(
            'https://relay.example.test',
            { serverId: 'srv_old_identity' },
        );
    }, 120_000);

    it('rejects replacement Account credentials returned after an asynchronous scoped lookup', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://account-switch.example.test', name: 'Account switch' });
        const pendingCredentials = createDeferred<typeof credentials>();
        mocks.getCredentialsForServerUrl.mockReturnValue(pendingCredentials.promise);
        const { requireSessionOrganizationMutationScope } = await import('./requireSessionOrganizationMutationScope');
        const pending = requireSessionOrganizationMutationScope(created.id, { expectedAccountId: 'account-original' });
        const result = expect(pending).rejects.toMatchObject({ code: 'session_organization_accountMismatch' });
        pendingCredentials.resolve({ token: createAccountTokenForTests('account-replacement'), secret: 'replacement-secret' });
        await result;
    });

    it('reports stable unavailable reasons without throwing so UI adapters can choose their error policy', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { resolveSessionOrganizationMutationScope } = await import('./sessionOrganizationMutationOwner');

        await expect(resolveSessionOrganizationMutationScope('')).resolves.toEqual({
            ok: false,
            reason: 'serverIdRequired',
            requestedServerId: '',
        });
        await expect(resolveSessionOrganizationMutationScope('missing-server')).resolves.toEqual({
            ok: false,
            reason: 'serverProfileUnavailable',
            requestedServerId: 'missing-server',
        });

        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://no-credentials.example.test',
            name: 'No credentials',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_no_credentials');
        mocks.getCredentialsForServerUrl.mockResolvedValue(null);

        await expect(resolveSessionOrganizationMutationScope(created.id)).resolves.toEqual({
            ok: false,
            reason: 'credentialsUnavailable',
            requestedServerId: created.id,
            serverId: 'srv_no_credentials',
        });
    }, 120_000);

    it('turns a typed unavailable scope into a retryable exact-Home UI error', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://no-credentials-ui.example.test',
            name: 'No credentials UI',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_no_credentials_ui');
        mocks.getCredentialsForServerUrl.mockResolvedValue(null);
        const { requireSessionOrganizationMutationScope } = await import('./requireSessionOrganizationMutationScope');

        await expect(requireSessionOrganizationMutationScope(created.id)).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: true,
            code: 'session_organization_credentialsUnavailable',
            message: expect.stringContaining(created.id),
        });
    }, 120_000);

    it('writes only changed folder definitions and workspace labels from current to next state', async () => {
        mocks.upsertSessionOrganizationFolder.mockImplementation(async ({ request }) => ({
            folder: {
                folderId: request.folderId,
                folderKey: request.folderKey,
                parentFolderId: request.parentFolderId,
                parentFolderKey: request.parentFolderKey,
                sortKey: request.sortKey,
                display: request.display,
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            },
        }));
        mocks.deleteSessionOrganizationFolder.mockImplementation(async ({ request }) => ({
            deletedFolderIds: [request.folderId],
            assignmentTargetFolderId: null,
            affectedAssignmentCount: 0,
        }));
        mocks.upsertSessionOrganizationLabel.mockImplementation(async ({ request }) => ({
            label: {
                labelKind: request.labelKind,
                scopeKey: request.scopeKey,
                display: request.display,
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            },
        }));
        mocks.deleteSessionOrganizationLabel.mockImplementation(async ({ request }) => ({
            labelKind: request.labelKind,
            scopeKey: request.scopeKey,
            archived: true,
        }));
        const {
            writeSessionOrganizationFolders,
            writeSessionOrganizationWorkspaceLabels,
        } = await import('./sessionOrganizationMutationOwner');
        const scope = {
            credentials,
            serverId: 'srv_current_identity',
            serverIdAliases: ['profile-a', 'srv-old'],
            serverUrl: 'https://relay.example.test',
        };
        const unchanged = folder({ id: 'folder-unchanged', name: 'Unchanged', sortKey: '0001' });
        const changedBefore = folder({ id: 'folder-changed', name: 'Before', sortKey: '0002' });
        const changedAfter = folder({ id: 'folder-changed', name: 'After', sortKey: '0002' });
        const removed = folder({ id: 'folder-removed', name: 'Removed', sortKey: '0003' });
        const added = folder({ id: 'folder-added', name: 'Added', sortKey: '0004' });

        await writeSessionOrganizationFolders({
            scope,
            current: folders(unchanged, changedBefore, removed),
            next: folders(unchanged, changedAfter, added),
        });
        await writeSessionOrganizationWorkspaceLabels({
            scope,
            current: {
                unchanged: 'Unchanged',
                changed: 'Before',
                removed: 'Removed',
            },
            next: {
                unchanged: 'Unchanged',
                changed: 'After',
                added: 'Added',
            },
        });

        expect(mocks.upsertSessionOrganizationFolder).toHaveBeenCalledTimes(2);
        expect(mocks.upsertSessionOrganizationFolder.mock.calls.map(([call]) => call.request)).toEqual([
            expect.objectContaining({
                folderId: 'folder-changed',
                display: { t: 'plain', v: expect.objectContaining({ name: 'After' }) },
            }),
            expect.objectContaining({
                folderId: 'folder-added',
                display: { t: 'plain', v: expect.objectContaining({ name: 'Added' }) },
            }),
        ]);
        expect(mocks.deleteSessionOrganizationFolder).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                folderId: 'folder-removed',
                assignmentBehavior: 'moveAssignmentsToParent',
            },
        }));
        expect(mocks.upsertSessionOrganizationLabel).toHaveBeenCalledTimes(2);
        expect(mocks.upsertSessionOrganizationLabel.mock.calls.map(([call]) => call.request)).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'changed',
                display: { t: 'plain', v: { label: 'After' } },
            },
            {
                labelKind: 'workspace',
                scopeKey: 'added',
                display: { t: 'plain', v: { label: 'Added' } },
            },
        ]);
        expect(mocks.deleteSessionOrganizationLabel).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                labelKind: 'workspace',
                scopeKey: 'removed',
            },
        }));
    }, 120_000);
});
