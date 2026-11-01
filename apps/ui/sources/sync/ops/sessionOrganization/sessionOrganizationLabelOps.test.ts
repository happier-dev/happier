import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    deleteSessionOrganizationLabel: vi.fn(),
    upsertSessionOrganizationLabel: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: apiMocks.fetchAccountEncryptionMode,
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        deleteSessionOrganizationLabel: apiMocks.deleteSessionOrganizationLabel,
        upsertSessionOrganizationLabel: apiMocks.upsertSessionOrganizationLabel,
    };
});

describe('session organization label ops', () => {
    beforeEach(async () => {
        apiMocks.deleteSessionOrganizationLabel.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        apiMocks.upsertSessionOrganizationLabel.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('upserts and deletes workspace labels through the ops barrel', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { deleteSessionLabel, upsertSessionLabel } = await import('./index');

        apiMocks.upsertSessionOrganizationLabel.mockResolvedValueOnce({
            label: {
                labelKind: 'workspace',
                scopeKey: 'wl_project_a',
                display: { t: 'plain', v: { label: 'Project A' } },
                archivedAt: null,
                createdAt: 10,
                updatedAt: 11,
            },
        });

        await upsertSessionLabel({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            serverUrl: 'https://server-a.example',
            request: {
                labelKind: 'workspace',
                scopeKey: 'wl_project_a',
                display: { t: 'plain', v: { label: 'Project A' } },
            },
        });

        expect(getStorage().getState().sessionOrganizationLabelsByLabelKey['server-a:workspace:wl_project_a']?.display).toEqual({
            t: 'plain',
            v: { label: 'Project A' },
        });
        expect(apiMocks.upsertSessionOrganizationLabel).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                display: { t: 'plain', v: { label: 'Project A' } },
            }),
        }));

        apiMocks.deleteSessionOrganizationLabel.mockResolvedValueOnce({
            labelKind: 'workspace',
            scopeKey: 'wl_project_a',
            archived: true,
        });

        await deleteSessionLabel({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            serverUrl: 'https://server-a.example',
            request: {
                labelKind: 'workspace',
                scopeKey: 'wl_project_a',
            },
        });

        expect(getStorage().getState().sessionOrganizationLabelsByLabelKey['server-a:workspace:wl_project_a']).toBeUndefined();
    });

    it('serializes colour and rename intents through one workspace display writer, deleting only the last field', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setWorkspaceDisplay } = await import('./setWorkspaceDisplay');
        const context = { credentials: { token: 'token-a', secret: 'secret-a' }, serverId: 'server-a', workspaceKey: 'wl_a' };
        apiMocks.upsertSessionOrganizationLabel.mockImplementation(async ({ request }) => ({ label: { ...request, archivedAt: null, createdAt: 1, updatedAt: 2 } }));
        apiMocks.deleteSessionOrganizationLabel.mockResolvedValue({ labelKind: 'workspace', scopeKey: 'wl_a', archived: true });
        const color = { kind: 'accent', key: 'blue' } as const;
        await Promise.all([
            setWorkspaceDisplay({ ...context, patch: { label: 'Project' } }),
            setWorkspaceDisplay({ ...context, patch: { color } }),
        ]);
        expect(getStorage().getState().sessionOrganizationLabelsByLabelKey['server-a:workspace:wl_a']?.display).toEqual({ t: 'plain', v: { label: 'Project', color } });
        await setWorkspaceDisplay({ ...context, patch: { label: null } });
        expect(getStorage().getState().sessionOrganizationLabelsByLabelKey['server-a:workspace:wl_a']?.display).toEqual({ t: 'plain', v: { color } });
        await setWorkspaceDisplay({ ...context, patch: { color: null } });
        expect(getStorage().getState().sessionOrganizationLabelsByLabelKey['server-a:workspace:wl_a']).toBeUndefined();
    });
});
