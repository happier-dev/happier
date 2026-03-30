import { describe, expect, it, vi } from 'vitest';

const sessionAttachmentsUploadFileSpy = vi.fn();

vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({
    sessionAttachmentsUploadFile: (args: unknown) => sessionAttachmentsUploadFileSpy(args),
}));

describe('uploadAttachmentDraftsToSession', () => {
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

});
