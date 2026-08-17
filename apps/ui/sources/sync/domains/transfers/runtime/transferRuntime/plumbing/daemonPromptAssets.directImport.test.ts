import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../routing/resolvePreferScopedMachineRpc', () => ({
    resolvePreferScopedMachineRpc: async () => true,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => ({ success: false, error: 'unexpected rpc' }),
}));

import { uploadDaemonPromptAsset } from '../families/promptAssetTransfers';

describe('daemonPromptAssets upload', () => {
    beforeEach(() => {
        directImportUploadMock.mockReset();
        bulkJsonUploadMock.mockReset();
    });

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

    it('blocks the bulk JSON fallback when authenticated direct-import cleanup fails', async () => {
        directImportUploadMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import cleanup failed: abort rejected',
            errorCode: 'DIRECT_IMPORT_CLEANUP_FAILED',
        });

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
        );

        expect(result).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'Direct import cleanup failed: abort rejected',
        });
        expect(bulkJsonUploadMock).not.toHaveBeenCalled();
    });

    it('blocks the bulk JSON mutation after direct finalize committed but its result is unusable', async () => {
        directImportUploadMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import finalize committed but returned an unusable result',
            errorCode: 'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE',
        });
        bulkJsonUploadMock.mockResolvedValueOnce({
            ok: true as const,
            response: {
                ok: true,
                externalRef: { skillName: 'writer' },
                digest: 'digest-relay',
            },
        });

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
        );

        expect(result).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'Direct import finalize committed but returned an unusable result',
        });
        expect(bulkJsonUploadMock).not.toHaveBeenCalled();
    });

    it('blocks the bulk JSON mutation when an issued direct finalize has an indeterminate outcome', async () => {
        directImportUploadMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import finalize outcome is indeterminate after request issuance',
            errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
        });
        bulkJsonUploadMock.mockResolvedValueOnce({
            ok: true as const,
            response: {
                ok: true,
                externalRef: { skillName: 'writer' },
                digest: 'digest-relay',
            },
        });

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
        );

        expect(result).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'Direct import finalize outcome is indeterminate after request issuance',
        });
        expect(bulkJsonUploadMock).not.toHaveBeenCalled();
    });

    it('blocks the bulk JSON mutation when direct finalize requires retained-session recovery', async () => {
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            isActionable: () => true,
            invoke: vi.fn(),
        };
        directImportUploadMock.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        bulkJsonUploadMock.mockResolvedValueOnce({
            ok: true as const,
            response: {
                ok: true,
                externalRef: { skillName: 'writer' },
                digest: 'digest-relay',
            },
        });

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
        );

        expect(result).toEqual({
            success: false,
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            error: 'Finalize recovery is required',
            recovery,
        });
        expect(bulkJsonUploadMock).not.toHaveBeenCalled();
    });
});
