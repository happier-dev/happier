import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { uploadAttachmentDraftsToSession } from './uploadAttachmentDraftsToSession';
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';
import { t } from '@/text';

const sessionAttachmentsUploadFileSpy = vi.hoisted(() => vi.fn());
const runTransferFinalizeRecoveryMock = vi.hoisted(() => vi.fn());
const issuedHandle = { v: 1 as const, sessionId: 's1', id: 'issued-file' };

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

    it.each([undefined, { v: 1 as const, sessionId: 'other-session', id: 'old-issued' }])(
        'reuploads retained path-only or foreign-session drafts before returning issued ingress: %j', async attachmentHandle => {
            const handle = { v: 1 as const, sessionId: 's1', id: 'fresh-issued' };
            sessionAttachmentsUploadFileSpy.mockResolvedValue({ success: true, path: 'fresh.txt', sizeBytes: 1,
                sha256: 'a'.repeat(64), attachmentHandle: handle });
            const source = { kind: 'memory' as const, name: 'note.txt', bytes: new Uint8Array([1]) };
            const checkpoint = vi.fn();
            const result = await uploadAttachmentDraftsToSession({ sessionId: 's1', messageLocalId: 'm1',
                drafts: [{ id: 'd1', source, status: 'uploaded', uploadedPath: 'old.txt', attachmentHandle }],
                config: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none',
                    vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 }, applyDraftPatch: () => {}, onUploadedDraftCheckpoint: checkpoint });
            expect(result.uploaded[0]).toMatchObject({ path: 'fresh.txt', attachmentHandle: handle });
            expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledWith(expect.objectContaining({ file: source }));
            expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ attachmentHandle: handle }));
        },
    );

    it('releases an eager folder result without issuance so the user can retry the original source', async () => {
        const attachmentHandle = { v: 1 as const, sessionId: 's1', id: 'issued-folder' };
        sessionAttachmentsUploadFileSpy.mockResolvedValueOnce({ success: true, path: 'folder', sizeBytes: 1, sha256: 'a'.repeat(64) })
            .mockResolvedValueOnce({ success: true, path: 'folder-retry', sizeBytes: 1, sha256: 'a'.repeat(64), attachmentHandle });
        const draft = { id: 'folder-draft', status: 'pending' as const,
            source: { kind: 'folder' as const, name: 'project', entries: [{ relativePath: 'note.txt',
                source: { kind: 'memory' as const, name: 'note.txt', bytes: new Uint8Array([1]) } }] } };
        const args = { sessionId: 's1', drafts: [draft], config: { uploadLocation: 'workspace' as const,
            workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none' as const,
            vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 }, applyDraftPatch: vi.fn() };
        await expect(uploadAttachmentDraftsToSession(args)).rejects.toThrow(describeUploadFailure('other', t('common.machine')));
        await expect(uploadAttachmentDraftsToSession(args)).resolves.toMatchObject({ uploaded: [{ attachmentHandle }] });
    });

    it.each(['response', 'throw'] as const)('classifies a raw transfer %s for the tray and send caller', async mode => {
        const raw = 'listen EADDRINUSE: address already in use 127.0.0.1:46001';
        if (mode === 'response') sessionAttachmentsUploadFileSpy.mockResolvedValue({ success: false, error: raw, errorCode: 'EADDRINUSE' });
        else sessionAttachmentsUploadFileSpy.mockRejectedValue(Object.assign(new Error(raw), { errorCode: 'EADDRINUSE' }));
        const applyDraftPatch = vi.fn();
        const failure = await uploadAttachmentDraftsToSession({ sessionId: 's1', messageLocalId: 'm1',
            drafts: [{ id: 'image', status: 'pending', source: { kind: 'memory', name: 'screen.png', bytes: new Uint8Array([1]), mimeType: 'image/png' } }],
            config: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 }, applyDraftPatch,
        }).catch((error: unknown) => error);
        const humanReason = describeUploadFailure('other', t('common.machine'));
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(humanReason);
        expect(failure).toMatchObject({ rpcErrorCode: 'EADDRINUSE' });
        expect(applyDraftPatch).toHaveBeenLastCalledWith('image', { status: 'error', error: humanReason, errorCode: 'EADDRINUSE' });
    });

    it('retains the issued attachment handle in message metadata and on uploaded-draft retry', async () => {
        const { uploadAttachmentDraftsToSession, buildSessionAttachmentIngressMeta } = await import('./uploadAttachmentDraftsToSession');
        const { RawIngressStructuredInputV1Schema } = await import('@happier-dev/protocol/runtime/input/structuredInputV1');
        const handle = { v: 1 as const, sessionId: 's1', id: 'issued-handle' };
        const result = await uploadAttachmentDraftsToSession({
            sessionId: 's1', messageLocalId: 'm1',
            drafts: [{ id: 'd1', source: { kind: 'memory', name: 'screen.png', bytes: new Uint8Array([1]), mimeType: 'image/png' },
                status: 'uploaded', uploadedPath: 'attachments/screen.png', uploadedSizeBytes: 1, attachmentHandle: handle }],
            config: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 },
            applyDraftPatch: () => {},
        });
        const metadata = buildSessionAttachmentIngressMeta(result.uploaded);
        expect(RawIngressStructuredInputV1Schema.parse(metadata.happierStructuredInputV1))
            .toEqual({ v: 1, sessionAttachments: [handle] });
        expect(metadata).not.toHaveProperty('happier');
        expect(result.uploaded[0]?.structuredInput).toMatchObject({ id: 'd1' });
        expect(sessionAttachmentsUploadFileSpy).not.toHaveBeenCalled();
    });

    it('updates draft progress and preserves the uploaded attachment result contract', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');

        sessionAttachmentsUploadFileSpy.mockResolvedValue({
            success: true,
            path: '.happier/uploads/messages/m1/12345678-file.png',
            sizeBytes: 5,
            sha256: 'h1',
            attachmentHandle: issuedHandle,
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
                attachmentHandle: issuedHandle,
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
                    id: 'd1',
                    name: 'file.png',
                    path: '.happier/uploads/messages/m1/12345678-file.png',
                    mimeType: 'image/png',
                    sizeBytes: 5,
                    sha256: 'h1',
                    attachmentHandle: issuedHandle,
                    structuredInput: {
                        id: 'd1',
                        type: 'localImage',
                        kind: 'localImage',
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
            attachmentHandle: issuedHandle,
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
            id: 'd1',
            name: 'readme.md',
            path: '.happier/uploads/messages/m1/readme.md',
            mimeType: 'text/markdown',
            sizeBytes: 12,
            sha256: 'h2',
            attachmentHandle: issuedHandle,
        });
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
            message: describeUploadFailure('other', t('common.machine')),
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it('finishes the exact staged attachment without reading or uploading it again', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            isActionable: () => true,
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
                attachmentHandle: issuedHandle,
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

    it('awaits the owner checkpoint for each uploaded draft before starting the next file', async () => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');
        let releaseCheckpoint!: () => void;
        const checkpoint = vi.fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => {
                releaseCheckpoint = resolve;
            }))
            .mockResolvedValue(undefined);
        sessionAttachmentsUploadFileSpy
            .mockResolvedValueOnce({
                success: true,
                path: '.happier/uploads/messages/m1/first.txt',
                sizeBytes: 5,
                sha256: 'a'.repeat(64),
                attachmentHandle: { ...issuedHandle, id: 'issued-first' },
            })
            .mockResolvedValueOnce({
                success: true,
                path: '.happier/uploads/messages/m1/second.txt',
                sizeBytes: 6,
                sha256: 'b'.repeat(64),
                attachmentHandle: { ...issuedHandle, id: 'issued-second' },
            });

        const pending = uploadAttachmentDraftsToSession({
            sessionId: 's1',
            drafts: [
                {
                    id: 'first',
                    source: { kind: 'memory', name: 'first.txt', bytes: new Uint8Array(5) },
                    status: 'pending',
                },
                {
                    id: 'second',
                    source: { kind: 'memory', name: 'second.txt', bytes: new Uint8Array(6) },
                    status: 'pending',
                },
            ],
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            applyDraftPatch: () => {},
            onUploadedDraftCheckpoint: checkpoint,
        });

        await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
        expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
            id: 'first',
            uploadedPath: '.happier/uploads/messages/m1/first.txt',
            uploadedSizeBytes: 5,
            sha256: 'a'.repeat(64),
        }));
        expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledTimes(1);

        releaseCheckpoint();
        await pending;
        expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledTimes(2);
        expect(checkpoint).toHaveBeenCalledTimes(2);
    });

});
