import { describe, expect, it, vi } from 'vitest';

const directImportUploadMock = vi.hoisted(() => vi.fn());
const bulkJsonUploadMock = vi.hoisted(() => vi.fn());

vi.mock('./directTransferImportUpload', () => ({
    uploadBulkPayloadFromFileViaDirectImport: (...args: unknown[]) => directImportUploadMock(...args),
}));

vi.mock('./uploadBulkJsonPayload', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./uploadBulkJsonPayload')>();
    return {
        ...actual,
        uploadBulkJsonPayload: (...args: unknown[]) => bulkJsonUploadMock(...args),
    };
});

vi.mock('../transferSubstrate/resolvePreferScopedMachineRpc', () => ({
    resolvePreferScopedMachineRpc: async () => true,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => ({ success: false, error: 'unexpected rpc' }),
}));

describe('daemonPromptAssets upload', () => {
    it('tries direct import first and falls back to the bulk JSON pipeline on failure', async () => {
        directImportUploadMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import upload unavailable',
        });
        bulkJsonUploadMock.mockResolvedValueOnce({
            ok: true as const,
            response: {
                ok: true,
                externalRef: { skillName: 'writer' },
                digest: 'digest-a',
            },
        });

        const { uploadDaemonPromptAsset } = await import('../transferSubstrate/promptAssetTransfers');
        const result = await uploadDaemonPromptAsset(
            'machine-1',
            {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: null,
                targetName: 'writer',
                title: 'Writer',
                bundleSchemaId: 'skills.skill_md_v1',
                bundleBody: {
                    v: 1,
                    entries: [],
                    createdAtMs: 1,
                    updatedAtMs: 1,
                },
                previewOnly: false,
                expectedDigest: null,
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });
        expect(directImportUploadMock).toHaveBeenCalledTimes(1);
        expect(directImportUploadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({
                t: 'prompt_asset_upload_v1',
                sizeBytes: expect.any(Number),
            }),
            parseFinalizeResponse: expect.any(Function),
        }));
        expect(bulkJsonUploadMock).toHaveBeenCalledTimes(1);
    });
});
