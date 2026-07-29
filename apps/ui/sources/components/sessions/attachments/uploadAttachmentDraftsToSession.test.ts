import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const sessionAttachmentsUploadFileSpy = vi.fn();
const runTransferFinalizeRecoveryMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({
    sessionAttachmentsUploadFile: (args: unknown) => sessionAttachmentsUploadFileSpy(args),
}));

vi.mock('@/components/transfers/recovery/runTransferFinalizeRecovery', () => ({
    runTransferFinalizeRecovery: (...args: unknown[]) => runTransferFinalizeRecoveryMock(...args),
}));

describe('uploadAttachmentDraftsToSession', () => {
    beforeEach(() => {
        sessionAttachmentsUploadFileSpy.mockReset();
        runTransferFinalizeRecoveryMock.mockReset();
    });
    it('updates draft progress and preserves the uploaded attachment result contract', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');

        sessionAttachmentsUploadFileSpy.mockResolvedValue({
            success: true,
            path: '.happier/uploads/messages/m1/12345678-file.png',
            sizeBytes: 5,
            sha256: 'h1',
        });

        const file = typeof File === 'function'
            ? new File([new TextEncoder().encode('hello')], 'file.png', { type: 'image/png' })
            : ({ name: 'file.png', size: 5, type: 'image/png', slice: () => new Blob([]) } as any);

        const drafts: any[] = [
            {
                id: 'd1',
                source: { kind: 'web', file },
                status: 'pending',
            },
        ];

        const patches: Array<{ id: string; patch: any }> = [];
        const applyDraftPatch = (id: string, patch: any) => {
            patches.push({ id, patch });
        };

        sessionAttachmentsUploadFileSpy.mockImplementation(async ({ onProgress }: any) => {
            onProgress?.({ uploadedBytes: 2, totalBytes: 5 });
            onProgress?.({ uploadedBytes: 5, totalBytes: 5 });
            return {
                success: true,
                path: '.happier/uploads/messages/m1/12345678-file.png',
                sizeBytes: 5,
                sha256: 'h1',
            };
        });

        const res = await uploadAttachmentDraftsToSession({
            sessionId: 's1',
            drafts,
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            applyDraftPatch,
        });

        expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            messageLocalId: 'm1',
            config: expect.objectContaining({
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
            }),
        }));

        expect(res).toEqual({
            messageLocalId: 'm1',
            uploaded: [
                {
                    name: 'file.png',
                    path: '.happier/uploads/messages/m1/12345678-file.png',
                    mimeType: 'image/png',
                    sizeBytes: 5,
                    sha256: 'h1',
                    structuredInput: {
                        type: 'localImage',
                        kind: 'image',
                        localPath: '.happier/uploads/messages/m1/12345678-file.png',
                        path: '.happier/uploads/messages/m1/12345678-file.png',
                        provenance: { kind: 'sessionAttachmentUpload' },
                        mimeType: 'image/png',
                        name: 'file.png',
                        sizeBytes: 5,
                        sha256: 'h1',
                    },
                },
            ],
        });

        const progressValues = patches
            .map((p) => p.patch?.uploadProgress ?? null)
            .filter((p): p is { uploadedBytes: number; totalBytes: number } => Boolean(p));

        expect(progressValues).toContainEqual({ uploadedBytes: 2, totalBytes: 5 });
        expect(progressValues.at(-1)).toMatchObject({ uploadedBytes: 5, totalBytes: 5 });
        expect(patches.at(-1)?.patch).toMatchObject({
            status: 'uploaded',
            uploadedPath: '.happier/uploads/messages/m1/12345678-file.png',
            uploadedSizeBytes: 5,
            uploadedMimeType: 'image/png',
            sha256: 'h1',
        });
    });

    it('does not add structured image metadata for non-image attachments', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');

        sessionAttachmentsUploadFileSpy.mockResolvedValue({
            success: true,
            path: '.happier/uploads/messages/m1/readme.md',
            sizeBytes: 12,
            sha256: 'h2',
        });

        const drafts: any[] = [
            {
                id: 'd1',
                source: {
                    kind: 'native',
                    name: 'readme.md',
                    mimeType: 'text/markdown',
                    uri: 'file:///tmp/readme.md',
                    sizeBytes: 12,
                },
                status: 'pending',
            },
        ];

        const res = await uploadAttachmentDraftsToSession({
            sessionId: 's1',
            drafts,
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            applyDraftPatch: () => {},
        });

        expect(res.uploaded[0]).toEqual({
            name: 'readme.md',
            path: '.happier/uploads/messages/m1/readme.md',
            mimeType: 'text/markdown',
            sizeBytes: 12,
            sha256: 'h2',
        });
    });

    it('builds transcript metadata with structured uploaded-image metadata', async () => {
        const module = await import('./uploadAttachmentDraftsToSession');
        expect(typeof module.buildAttachmentMessageMeta).toBe('function');

        const meta = module.buildAttachmentMessageMeta([
            {
                name: 'screen.png',
                path: '.happier/uploads/messages/m1/screen.png',
                mimeType: 'image/png',
                sizeBytes: 42,
                sha256: 'h1',
                structuredInput: {
                    type: 'localImage',
                    kind: 'image',
                    localPath: '.happier/uploads/messages/m1/screen.png',
                    path: '.happier/uploads/messages/m1/screen.png',
                    mimeType: 'image/png',
                    name: 'screen.png',
                    sizeBytes: 42,
                    sha256: 'h1',
                },
            },
        ]);

        expect(meta).toMatchObject({
            happier: {
                kind: 'attachments.v1',
                payload: {
                    attachments: [
                        {
                            name: 'screen.png',
                            path: '.happier/uploads/messages/m1/screen.png',
                            mimeType: 'image/png',
                            sizeBytes: 42,
                            sha256: 'h1',
                        },
                    ],
                },
            },
            happierStructuredInputV1: {
                v: 1,
                imageInputs: [
                    {
                        type: 'localImage',
                        kind: 'image',
                        localPath: '.happier/uploads/messages/m1/screen.png',
                        path: '.happier/uploads/messages/m1/screen.png',
                        provenance: { kind: 'sessionAttachmentUpload' },
                    },
                ],
            },
        });
        expect(JSON.stringify(meta.happierStructuredInputV1)).not.toContain('"attachments":[');
    });

    it('preserves the upload failure error code on the thrown error', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');

        sessionAttachmentsUploadFileSpy.mockResolvedValue({
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

        const drafts: any[] = [
            {
                id: 'd1',
                source: {
                    kind: 'native',
                    name: 'readme.md',
                    mimeType: 'text/markdown',
                    uri: 'file:///tmp/readme.md',
                    sizeBytes: 12,
                },
                status: 'pending',
            },
        ];

        await expect(uploadAttachmentDraftsToSession({
            sessionId: 's1',
            drafts,
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            applyDraftPatch: () => {},
        })).rejects.toMatchObject({
            message: 'Machine target not available for session',
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it('finishes the exact staged attachment without reading or uploading it again', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            invoke: vi.fn(),
        };
        sessionAttachmentsUploadFileSpy.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        runTransferFinalizeRecoveryMock.mockResolvedValueOnce({
            status: 'finalized',
            response: {
                success: true,
                path: '.happier/uploads/messages/m1/readme.md',
                sizeBytes: 12,
                sha256: 'sha256',
            },
        });

        const result = await uploadAttachmentDraftsToSession({
            sessionId: 's1',
            drafts: [{
                id: 'd1',
                source: {
                    kind: 'native',
                    name: 'readme.md',
                    mimeType: 'text/markdown',
                    uri: 'file:///tmp/readme.md',
                    sizeBytes: 12,
                },
                status: 'pending',
            }],
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            applyDraftPatch: vi.fn(),
        });

        expect(result.uploaded).toHaveLength(1);
        expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledTimes(1);
        expect(runTransferFinalizeRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({ recovery }));
    });

});
