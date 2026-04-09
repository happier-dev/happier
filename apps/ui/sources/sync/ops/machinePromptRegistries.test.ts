import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PromptRegistryFetchItemRequestV1,
    PromptRegistryInstallRequestV1,
    PromptRegistryListSourcesRequestV1,
    PromptRegistryScanSourceRequestV1,
} from '@happier-dev/protocol';

const downloadDaemonPromptRegistryItemMock = vi.hoisted(() => vi.fn());
const installDaemonPromptRegistryItemMock = vi.hoisted(() => vi.fn());
const listDaemonPromptRegistryAdaptersMock = vi.hoisted(() => vi.fn());
const listDaemonPromptRegistrySourcesMock = vi.hoisted(() => vi.fn());
const scanDaemonPromptRegistrySourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    downloadDaemonPromptRegistryItem: (...args: unknown[]) => downloadDaemonPromptRegistryItemMock(...args),
    installDaemonPromptRegistryItem: (...args: unknown[]) => installDaemonPromptRegistryItemMock(...args),
    listDaemonPromptRegistryAdapters: (...args: unknown[]) => listDaemonPromptRegistryAdaptersMock(...args),
    listDaemonPromptRegistrySources: (...args: unknown[]) => listDaemonPromptRegistrySourcesMock(...args),
    scanDaemonPromptRegistrySource: (...args: unknown[]) => scanDaemonPromptRegistrySourceMock(...args),
}));

describe('machine prompt registries ops', () => {
    beforeEach(() => {
        downloadDaemonPromptRegistryItemMock.mockReset();
        installDaemonPromptRegistryItemMock.mockReset();
        listDaemonPromptRegistryAdaptersMock.mockReset();
        listDaemonPromptRegistrySourcesMock.mockReset();
        scanDaemonPromptRegistrySourceMock.mockReset();
    });

    it('delegates adapter listing to the transfer substrate', async () => {
        listDaemonPromptRegistryAdaptersMock.mockResolvedValueOnce({ ok: true, adapters: [] });
        const { machinePromptRegistriesListAdapters } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesListAdapters('machine-1', { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            adapters: [],
        });

        expect(listDaemonPromptRegistryAdaptersMock).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
    });

    it('delegates source listing to the transfer substrate', async () => {
        const request: PromptRegistryListSourcesRequestV1 = { configuredSources: [] };
        listDaemonPromptRegistrySourcesMock.mockResolvedValueOnce({ ok: true, sources: [] });
        const { machinePromptRegistriesListSources } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesListSources('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            sources: [],
        });

        expect(listDaemonPromptRegistrySourcesMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('delegates source scans to the transfer substrate', async () => {
        const request: PromptRegistryScanSourceRequestV1 = { sourceId: 'skills_sh:featured', configuredSources: [] };
        scanDaemonPromptRegistrySourceMock.mockResolvedValueOnce({ ok: true, items: [] });
        const { machinePromptRegistriesScanSource } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesScanSource('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            items: [],
        });

        expect(scanDaemonPromptRegistrySourceMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('maps substrate downloads onto the item response shape', async () => {
        const request: PromptRegistryFetchItemRequestV1 = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            configuredSources: [],
        };
        const item = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            title: 'frontend-design',
            description: 'anthropics/skills',
            bundleSchemaId: 'skills.skill_md_v1',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        downloadDaemonPromptRegistryItemMock.mockResolvedValueOnce({ ok: true, item });
        const { machinePromptRegistriesDownloadItem } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesDownloadItem('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            item,
        });

        expect(downloadDaemonPromptRegistryItemMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });

    it('delegates installs to the transfer substrate', async () => {
        const request: PromptRegistryInstallRequestV1 = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            configuredSources: [],
            installTarget: {
                assetTypeId: 'agents.skill',
                scope: 'user',
                directory: '/tmp/project',
                targetName: 'frontend-design',
            },
        };
        installDaemonPromptRegistryItemMock.mockResolvedValueOnce({ ok: true });
        const { machinePromptRegistriesInstall } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesInstall('machine-1', request, { serverId: 'server-a' })).resolves.toEqual({ ok: true });

        expect(installDaemonPromptRegistryItemMock).toHaveBeenCalledWith('machine-1', request, { serverId: 'server-a' });
    });
});
