import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PromptAssetDeleteRequest,
    PromptAssetDiscoverRequest,
    PromptAssetReadRequest,
    PromptAssetWriteRequest,
} from '@happier-dev/protocol';

const deleteDaemonPromptAssetMock = vi.hoisted(() => vi.fn());
const discoverDaemonPromptAssetsMock = vi.hoisted(() => vi.fn());
const downloadDaemonPromptAssetMock = vi.hoisted(() => vi.fn());
const listDaemonPromptAssetTypesMock = vi.hoisted(() => vi.fn());
const uploadDaemonPromptAssetMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    deleteDaemonPromptAsset: (...args: unknown[]) => deleteDaemonPromptAssetMock(...args),
    discoverDaemonPromptAssets: (...args: unknown[]) => discoverDaemonPromptAssetsMock(...args),
    downloadDaemonPromptAsset: (...args: unknown[]) => downloadDaemonPromptAssetMock(...args),
    listDaemonPromptAssetTypes: (...args: unknown[]) => listDaemonPromptAssetTypesMock(...args),
    uploadDaemonPromptAsset: (...args: unknown[]) => uploadDaemonPromptAssetMock(...args),
}));

describe('machine prompt assets ops', () => {
    beforeEach(() => {
        deleteDaemonPromptAssetMock.mockReset();
        discoverDaemonPromptAssetsMock.mockReset();
        downloadDaemonPromptAssetMock.mockReset();
        listDaemonPromptAssetTypesMock.mockReset();
        uploadDaemonPromptAssetMock.mockReset();
    });

    it('delegates type listing to the transfer substrate', async () => {
        listDaemonPromptAssetTypesMock.mockResolvedValueOnce({ ok: true, types: [] });
        const { machinePromptAssetsListTypes } = await import('./machinePromptAssets');

        await expect(machinePromptAssetsListTypes('machine-1', { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            types: [],
        });

        expect(listDaemonPromptAssetTypesMock).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
    });

    it('delegates discovery to the transfer substrate', async () => {
        discoverDaemonPromptAssetsMock.mockResolvedValueOnce({ ok: true, items: [] });
        const { machinePromptAssetsDiscover } = await import('./machinePromptAssets');
        const request: PromptAssetDiscoverRequest = { assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project' };

        await expect(machinePromptAssetsDiscover('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            items: [],
        });

        expect(discoverDaemonPromptAssetsMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('maps substrate downloads onto the item response shape', async () => {
        const item = {
            assetTypeId: 'agents.skill',
            scope: 'user',
            externalRef: { name: 'skill-a' },
            title: 'Skill A',
            libraryKind: 'bundle',
            bundleSchemaId: 'skills.skill_md_v1',
            digest: 'digest-a',
            displayPath: '~/.agents/skills/skill-a',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        downloadDaemonPromptAssetMock.mockResolvedValueOnce({ ok: true, item });
        const { machinePromptAssetsDownload } = await import('./machinePromptAssets');
        const request: PromptAssetReadRequest = { assetTypeId: 'agents.skill', scope: 'user', externalRef: { name: 'skill-a' } };

        await expect(machinePromptAssetsDownload('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            item,
        });

        expect(downloadDaemonPromptAssetMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('delegates writes to the transfer substrate', async () => {
        const request: PromptAssetWriteRequest = {
            assetTypeId: 'agents.skill',
            scope: 'user',
            externalRef: null,
            targetName: 'writer',
            title: 'Writer',
            bundleSchemaId: 'skills.skill_md_v1',
            bundleBody: {
                v: 1 as const,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
            previewOnly: false,
            expectedDigest: null,
        };
        uploadDaemonPromptAssetMock.mockResolvedValueOnce({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });
        const { machinePromptAssetsWrite } = await import('./machinePromptAssets');

        await expect(machinePromptAssetsWrite('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });

        expect(uploadDaemonPromptAssetMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('delegates deletion to the transfer substrate', async () => {
        const request: PromptAssetDeleteRequest = { assetTypeId: 'agents.skill', scope: 'user', externalRef: { name: 'skill-a' } };
        deleteDaemonPromptAssetMock.mockResolvedValueOnce({ ok: true });
        const { machinePromptAssetsDelete } = await import('./machinePromptAssets');

        await expect(machinePromptAssetsDelete('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({ ok: true });

        expect(deleteDaemonPromptAssetMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });
});
