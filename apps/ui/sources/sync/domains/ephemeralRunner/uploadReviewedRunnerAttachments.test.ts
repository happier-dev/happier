import { describe, expect, it, vi } from 'vitest';

import { uploadReviewedRunnerAttachments } from './uploadReviewedRunnerAttachments';

type UploadFile = NonNullable<Parameters<typeof uploadReviewedRunnerAttachments>[0]['uploadFile']>;

function sourceName(file: Parameters<UploadFile>[0]['file']): string {
    return file.kind === 'web' ? file.file.name : file.name;
}

describe('uploadReviewedRunnerAttachments', () => {
    it('reuploads a retained path-only checkpoint from staged custody and checkpoints its issued handle', async () => {
        const sha256 = 'd'.repeat(64);
        const attachmentHandle = { v: 1 as const, sessionId: 'session-1', id: 'issued-recovered' };
        const onVerifiedUpload = vi.fn();
        const uploadFile = vi.fn<UploadFile>(async () => ({ success: true, path: 'uploads/recovered.txt', sizeBytes: 8, sha256, attachmentHandle }));
        const uploaded = await uploadReviewedRunnerAttachments({ sessionId: 'session-1', messageLocalId: 'message-1',
            reviewedFiles: [{ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, sha256 }],
            stagedFiles: [{ id: 'file-1', source: { kind: 'memory', name: 'notes.txt', bytes: new Uint8Array(8) } }],
            resumedUploads: [{ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', path: 'uploads/old.txt', sizeBytes: 8, sha256 }],
            destination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
            maxFileBytes: 1024, admitInitialPrompt: () => {}, onVerifiedUpload, uploadFile,
        });
        expect(uploaded).toMatchObject([{ path: 'uploads/recovered.txt', attachmentHandle }]);
        expect(onVerifiedUpload).toHaveBeenCalledWith(expect.objectContaining({ path: 'uploads/recovered.txt', attachmentHandle }));
        expect(uploadFile).toHaveBeenCalledOnce();
    });
    it('keeps the reviewed tray identity on rebuilt image input after checkpoint recovery', async () => {
        const sha256 = 'd'.repeat(64);
        const attachmentHandle = { v: 1 as const, sessionId: 'session-1', id: 'issued-image-1' };
        const uploaded = await uploadReviewedRunnerAttachments({ sessionId: 'session-1', messageLocalId: 'message-1',
            reviewedFiles: [{ id: 'image-1', name: 'screen.png', mimeType: 'image/png', sizeBytes: 8, sha256 }],
            stagedFiles: [{ id: 'image-1', source: { kind: 'memory', name: 'screen.png', mimeType: 'image/png', bytes: new Uint8Array(8) } }],
            resumedUploads: [{ id: 'image-1', name: 'screen.png', mimeType: 'image/png', path: 'uploads/screen.png', sizeBytes: 8, sha256, attachmentHandle }],
            destination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
            maxFileBytes: 1024, admitInitialPrompt: () => {},
        });
        expect(uploaded[0]).toMatchObject({ id: 'image-1', attachmentHandle, structuredInput: { id: 'image-1' } });
    });
    it('does not admit the prompt when a later ordinary upload returns a different reviewed size', async () => {
        const digest = 'a'.repeat(64);
        const admitInitialPrompt = vi.fn();
        const uploadFile = vi.fn<UploadFile>(async ({ file }) => ({
            success: true,
            path: `.happier/uploads/${sourceName(file)}`,
            sizeBytes: sourceName(file) === 'second.txt' ? 7 : 8,
            sha256: digest,
            attachmentHandle: { v: 1, sessionId: 'session-1', id: sourceName(file) },
        }));

        await expect(uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [
                { id: 'file-1', name: 'first.txt', mimeType: 'text/plain', sizeBytes: 8, sha256: digest },
                { id: 'file-2', name: 'second.txt', mimeType: 'text/plain', sizeBytes: 8, sha256: digest },
            ],
            stagedFiles: [
                { id: 'file-1', source: { kind: 'memory', name: 'first.txt', bytes: new Uint8Array(8) } },
                { id: 'file-2', source: { kind: 'memory', name: 'second.txt', bytes: new Uint8Array(8) } },
            ],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt,
            uploadFile,
        })).rejects.toMatchObject({ code: 'runner_attachment_size_mismatch' });

        expect(uploadFile).toHaveBeenCalledTimes(2);
        expect(admitInitialPrompt).not.toHaveBeenCalled();
    });

    it('rejects a returned digest mismatch before admitting the initial prompt', async () => {
        const admitInitialPrompt = vi.fn();
        const uploadFile = vi.fn<UploadFile>(async () => ({
            success: true,
            path: '.happier/uploads/reviewed.txt',
            sizeBytes: 8,
            sha256: 'b'.repeat(64),
            attachmentHandle: { v: 1, sessionId: 'session-1', id: 'issued-reviewed' },
        }));

        await expect(uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [{
                id: 'file-1',
                name: 'reviewed.txt',
                mimeType: 'text/plain',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
            }],
            stagedFiles: [{
                id: 'file-1',
                source: {
                    kind: 'memory',
                    name: 'reviewed.txt',
                    mimeType: 'text/plain',
                    bytes: new Uint8Array(8),
                },
            }],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt,
            uploadFile,
        })).rejects.toMatchObject({ code: 'runner_attachment_digest_mismatch' });

        expect(admitInitialPrompt).not.toHaveBeenCalled();
    });

    it('admits once with the ordinary uploader results after every reviewed file verifies', async () => {
        const digest = 'c'.repeat(64);
        const admitInitialPrompt = vi.fn(async () => undefined);
        const uploadFile = vi.fn<UploadFile>(async () => ({
            success: true,
            path: '.happier/uploads/reviewed.txt',
            sizeBytes: 8,
            sha256: digest,
            attachmentHandle: { v: 1, sessionId: 'session-1', id: 'issued-reviewed' },
        }));

        const uploaded = await uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            sessionTarget: { serverId: 'server-b', accountId: 'account-b', sessionId: 'session-1' },
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [{
                id: 'file-1',
                name: 'reviewed.txt',
                mimeType: 'text/plain',
                sizeBytes: 8,
                sha256: digest,
            }],
            stagedFiles: [{
                id: 'file-1',
                source: {
                    kind: 'memory',
                    name: 'reviewed.txt',
                    mimeType: 'text/plain',
                    bytes: new Uint8Array(8),
                },
            }],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt,
            uploadFile,
        });

        expect(uploaded).toEqual([{
            id: 'file-1',
            name: 'reviewed.txt',
            mimeType: 'text/plain',
            path: '.happier/uploads/reviewed.txt',
            sizeBytes: 8,
            sha256: digest,
            attachmentHandle: { v: 1, sessionId: 'session-1', id: 'issued-reviewed' },
        }]);
        expect(admitInitialPrompt).toHaveBeenCalledWith(uploaded);
        expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
            sessionTarget: { serverId: 'server-b', accountId: 'account-b', sessionId: 'session-1' },
            messageLocalId: 'initial-prompt-1',
        }));
    });

    it('seeds the ordinary uploader from verified activation custody after a partial-upload retry', async () => {
        const firstDigest = 'a'.repeat(64);
        const secondDigest = 'b'.repeat(64);
        const uploadFile = vi.fn<UploadFile>(async ({ file }) => ({
            success: true,
            path: `.happier/uploads/${sourceName(file)}`,
            sizeBytes: 9,
            sha256: secondDigest,
            attachmentHandle: { v: 1, sessionId: 'session-1', id: 'issued-second' },
        }));

        await uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [
                { id: 'file-1', name: 'first.txt', mimeType: 'text/plain', sizeBytes: 8, sha256: firstDigest },
                { id: 'file-2', name: 'second.txt', mimeType: 'text/plain', sizeBytes: 9, sha256: secondDigest },
            ],
            stagedFiles: [
                { id: 'file-1', source: { kind: 'memory', name: 'first.txt', bytes: new Uint8Array(8) } },
                { id: 'file-2', source: { kind: 'memory', name: 'second.txt', bytes: new Uint8Array(9) } },
            ],
            resumedUploads: [{
                id: 'file-1',
                name: 'first.txt',
                mimeType: 'text/plain',
                path: '.happier/uploads/first.txt',
                sizeBytes: 8,
                sha256: firstDigest,
                attachmentHandle: { v: 1, sessionId: 'session-1', id: 'issued-first' },
            }],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt: vi.fn(),
            uploadFile,
        });

        expect(uploadFile).toHaveBeenCalledOnce();
        expect(sourceName(uploadFile.mock.calls[0]![0].file)).toBe('second.txt');
    });

    it('rejects a corrupt resumed upload checkpoint before reusing its remote path', async () => {
        const uploadFile = vi.fn<UploadFile>();
        await expect(uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [{ id: 'file-1', name: 'first.txt', mimeType: 'text/plain', sizeBytes: 8, sha256: 'a'.repeat(64) }],
            stagedFiles: [{
                id: 'file-1',
                source: { kind: 'memory', name: 'first.txt', bytes: new Uint8Array(8) },
            }],
            resumedUploads: [{
                id: 'file-1',
                name: 'first.txt',
                path: '.happier/uploads/first.txt',
                sizeBytes: 7,
                sha256: 'a'.repeat(64),
            }],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt: vi.fn(),
            uploadFile,
        })).rejects.toMatchObject({ code: 'runner_attachment_manifest_mismatch' });
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a resumed upload whose MIME identity differs from the reviewed file', async () => {
        const uploadFile = vi.fn<UploadFile>();
        await expect(uploadReviewedRunnerAttachments({
            sessionId: 'session-1',
            messageLocalId: 'initial-prompt-1',
            reviewedFiles: [{
                id: 'file-1',
                name: 'first.txt',
                mimeType: 'text/plain',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
            }],
            stagedFiles: [{
                id: 'file-1',
                source: { kind: 'memory', name: 'first.txt', mimeType: 'text/plain', bytes: new Uint8Array(8) },
            }],
            resumedUploads: [{
                id: 'file-1',
                name: 'first.txt',
                mimeType: 'application/octet-stream',
                path: '.happier/uploads/first.txt',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
            }],
            destination: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            },
            maxFileBytes: 1024,
            admitInitialPrompt: vi.fn(),
            uploadFile,
        })).rejects.toMatchObject({ code: 'runner_attachment_manifest_mismatch' });
        expect(uploadFile).not.toHaveBeenCalled();
    });
});
