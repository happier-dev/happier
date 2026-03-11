import { describe, expect, it, vi } from 'vitest';

const sessionRPCSpy = vi.fn<(sessionId: string, method: string, payload: unknown) => Promise<any>>(async () => ({
    success: false,
    error: 'unconfigured',
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

describe('uploadAttachmentDraftsToSession', () => {
    it('updates upload progress on drafts while uploading', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string, _payload: unknown) => {
            if (method === 'attachments.configure') return { success: true };
            if (method === 'attachments.upload.init') return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === 'attachments.upload.chunk') return { success: true };
            if (method === 'attachments.upload.finalize') return { success: true, path: 'p1', sizeBytes: 5, sha256: 'h1' };
            return { success: false, error: `unexpected method ${method}` };
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
                uploadTtlMs: 5 * 60 * 1000,
                chunkSizeBytes: 256 * 1024,
            },
            applyDraftPatch,
        });

        expect(res.uploaded).toHaveLength(1);

        const progressValues = patches
            .map((p) => p.patch?.uploadProgress ?? null)
            .filter((p): p is { uploadedBytes: number; totalBytes: number } => Boolean(p));

        expect(progressValues.length).toBeGreaterThan(0);
        expect(progressValues.at(-1)).toMatchObject({ uploadedBytes: 5, totalBytes: 5 });
    });
});
