import { describe, expect, it, vi } from 'vitest';

const directExportDownloadMock = vi.hoisted(() => vi.fn());
const relayJsonDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('./directTransferExportDownload', () => ({
    downloadBulkJsonPayloadViaDirectExport: (...args: unknown[]) => directExportDownloadMock(...args),
}));

vi.mock('./downloadBulkJsonPayloadViaServerRelay', () => ({
    downloadBulkJsonPayloadViaServerRelay: (...args: unknown[]) => relayJsonDownloadMock(...args),
}));

vi.mock('../routing/resolvePreferScopedMachineRpc', () => ({
    resolvePreferScopedMachineRpc: async () => true,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => ({ success: false, error: 'unexpected rpc' }),
}));

describe('daemonPromptRegistries download', () => {
    it('tries direct export first, then relay json', async () => {
        const payload = {
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

        directExportDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayJsonDownloadMock.mockResolvedValueOnce({
            ok: true as const,
            payload,
        });

        const { downloadDaemonPromptRegistryItem } = await import('../families/promptRegistryTransfers');
        const result = await downloadDaemonPromptRegistryItem(
            'machine-1',
            {
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({ ok: true, item: payload });
        expect(directExportDownloadMock).toHaveBeenCalledTimes(1);
        expect(directExportDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_registry_download_v1',
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
            },
            parsePayload: expect.any(Function),
        }));
        expect(relayJsonDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayJsonDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: undefined,
            init: expect.any(Function),
            finalize: expect.any(Function),
            abort: expect.any(Function),
            parsePayload: expect.any(Function),
        }));
    });
});
