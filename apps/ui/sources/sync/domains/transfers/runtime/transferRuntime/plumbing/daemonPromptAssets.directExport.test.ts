import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { DaemonPromptAssetDownloadResponse } from '../families/promptAssetTransfers';

const directExportDownloadMock = vi.hoisted(() => vi.fn());
const relayJsonDownloadMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

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
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

describe('daemonPromptAssets download', () => {
    beforeEach(() => {
        directExportDownloadMock.mockReset();
        relayJsonDownloadMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: false,
            error: 'Chunk unavailable',
            errorCode: 'CHUNK_UNAVAILABLE',
        });
    });

    it('tries direct export first, then relay json', async () => {
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

        const { downloadDaemonPromptAsset } = await import('../families/promptAssetTransfers');
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
    });

    it('preserves the carrier errorCode when both direct export and relay fail', async () => {
        directExportDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayJsonDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Relay unavailable',
            errorCode: 'RELAY_UNAVAILABLE',
        });

        const { downloadDaemonPromptAsset } = await import('../families/promptAssetTransfers');
        const result = await downloadDaemonPromptAsset(
            'machine-1',
            {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({
            ok: false,
            error: 'Chunk unavailable',
            errorCode: 'CHUNK_UNAVAILABLE',
        });
    });
});

expectTypeOf<Extract<DaemonPromptAssetDownloadResponse, { ok: false }>>().toEqualTypeOf<Readonly<{
    ok: false;
    error: string;
    errorCode?: string;
}>>();
