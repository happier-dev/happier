import { describe, expect, it, vi } from 'vitest';

const directExportDownloadMock = vi.hoisted(() => vi.fn());
const relayJsonDownloadMock = vi.hoisted(() => vi.fn());
const bulkJsonDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('./directTransferExportDownload', () => ({
    downloadBulkJsonPayloadViaDirectExport: (...args: unknown[]) => directExportDownloadMock(...args),
}));

vi.mock('./downloadBulkJsonPayload', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./downloadBulkJsonPayload')>();
    return {
        ...actual,
        downloadBulkJsonPayload: (...args: unknown[]) => bulkJsonDownloadMock(...args),
    };
});

vi.mock('./downloadBulkJsonPayloadViaServerRelay', () => ({
    downloadBulkJsonPayloadViaServerRelay: (...args: unknown[]) => relayJsonDownloadMock(...args),
}));

vi.mock('./resolvePreferScopedForBulkMachineTransfer', () => ({
    resolvePreferScopedForBulkMachineTransfer: async () => true,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => ({ success: false, error: 'unexpected rpc' }),
}));

describe('daemonPromptAssets download', () => {
    it('tries direct export first, then relay json, before falling back to the legacy bulk JSON pipeline', async () => {
        const payload = {
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

        directExportDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayJsonDownloadMock.mockResolvedValueOnce({
            ok: true as const,
            payload,
        });

        const { downloadDaemonPromptAsset } = await import('./daemonPromptAssets');
        const result = await downloadDaemonPromptAsset(
            'machine-1',
            {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({ ok: true, item: payload });
        expect(directExportDownloadMock).toHaveBeenCalledTimes(1);
        expect(directExportDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
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
        expect(bulkJsonDownloadMock).not.toHaveBeenCalled();
    });
});
