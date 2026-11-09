import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: () => { },
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'draft-1',
}));

// Load the real transfer graph during collection, outside an individual hook's timing budget.
await import('./uploadAttachmentDraftsToSession');

describe('useAttachmentDraftManager (attachments.uploads)', () => {
    it.each(['before', 'during'] as const)('classifies owner cancellation %s the first upload without a failure or a second transfer', async phase => {
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const controller = new AbortController();
        const call = vi.fn(async (_method: string, _request: unknown, signal?: AbortSignal | null): Promise<never> => {
            return await new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const applyDraftPatch = vi.fn();
        if (phase === 'before') controller.abort();
        const pending = uploadAttachmentDraftsToSession({ sessionId: 's1', signal: controller.signal,
            transferContext: { kind: 'sessionBound', sessionId: 's1', call },
            drafts: ['first', 'second'].map(id => ({ id, status: 'pending',
                source: { kind: 'memory', name: `${id}.txt`, bytes: new Uint8Array([1]) } })),
            config: { uploadLocation: 'workspace', workspaceRelativeDir: '.uploads', vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 }, applyDraftPatch });
        const settlement = pending.catch((error: unknown) => error);
        if (phase === 'during') {
            await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
            controller.abort();
        }
        expect(await settlement).toMatchObject({ name: 'AttachmentUploadCancelled' });
        expect(applyDraftPatch.mock.calls.some(([, patch]) => patch.status === 'error' || patch.status === 'uploaded')).toBe(false);
        expect(call.mock.calls.map(([method]) => method)).toEqual(phase === 'before' ? [] : [RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT]);
    });

    it.each(['response', 'throw'] as const)('retains a typed Session upload %s on the draft and row until explicit retry', async mode => {
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const { RpcError } = await import('@/sync/runtime/rpcErrors');
        const { uploadAttachmentDraftsToSession } = await import('./uploadAttachmentDraftsToSession');
        const { createTransferRecipientKeyPair } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const { projectAgentInputAttachmentRowItem } = await import('../agentInput/agentInputContracts');
        const recipient = createTransferRecipientKeyPair();
        const errorCode = 'filesystem_identity_custody_unavailable';
        let refused = true;
        // Only the Session RPC transport is substituted; file reading, upload,
        // failure classification, draft custody and row projection remain real.
        const call = vi.fn(async (method: string): Promise<unknown> => {
            if (refused) {
                if (mode === 'throw') throw new RpcError('Private transport diagnostic', errorCode);
                return { success: false, error: 'Private transport diagnostic', errorCode };
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) return {
                success: true, uploadId: 'upload-a', chunkSizeBytes: 3,
                recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
            };
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) return {
                success: true, path: '.uploads/file.txt', sizeBytes: 3, sha256: 'digest',
                attachmentHandle: { v: 1, sessionId: 's1', id: 'upload-a' },
            };
            return { success: true };
        });
        const transferContext = { kind: 'sessionBound' as const, sessionId: 's1',
            call: async <T,>(method: string): Promise<T> => await call(method) as T };
        const config = { uploadLocation: 'workspace' as const, workspaceRelativeDir: '.uploads',
            vcsIgnoreStrategy: 'none' as const, vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024 }));
        try {
            await act(async () => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'memory',
                name: 'file.txt', bytes: new Uint8Array([1, 2, 3]) }] }); });
            const upload = () => uploadAttachmentDraftsToSession({ sessionId: 's1', transferContext, config,
                drafts: hook.getCurrent().getDraftsSnapshot(), messageLocalId: 'message-a',
                applyDraftPatch: (id, patch) => hook.getCurrent().applyDraftPatch(id, patch) });
            await act(async () => {
                await expect(upload()).rejects.toMatchObject({ rpcErrorCode: errorCode });
            });
            expect(hook.getCurrent().getDraftsSnapshot()[0]).toMatchObject({ status: 'error', errorCode });
            expect(hook.getCurrent().agentInputAttachments[0]).toMatchObject({ status: 'error', errorCode });
            expect(projectAgentInputAttachmentRowItem(hook.getCurrent().agentInputAttachments[0]!)).toMatchObject({ status: 'error', errorCode });
            expect(hook.getCurrent().agentInputAttachments[0]?.error).not.toContain('Private transport diagnostic');
            // A non-retryable refusal settles without chunk work, cleanup or re-polling.
            expect(call.mock.calls).toEqual([[RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT]]);
            refused = false;
            await act(async () => { await upload(); });
            expect(hook.getCurrent().getDraftsSnapshot()[0]).toMatchObject({ status: 'uploaded', error: undefined, errorCode: undefined });
            expect(hook.getCurrent().agentInputAttachments[0]).toMatchObject({ status: 'uploaded', errorCode: undefined });
            expect(projectAgentInputAttachmentRowItem(hook.getCurrent().agentInputAttachments[0]!)).not.toHaveProperty('errorCode');
        } finally { await hook.unmount(); }
    });

    it.each([true, false])('starts folder uploads at intake and checkpoints success=%s', async (success) => {
        const { createTransferRecipientKeyPair } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const recipient = createTransferRecipientKeyPair();
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        let finish: ((value: unknown) => void) | undefined;
        const finalizing = new Promise<unknown>(resolve => { finish = resolve; });
        let path = '';
        const call = vi.fn(async (method: string, request: unknown): Promise<unknown> => {
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                path = `.uploads/messages/m1/${(request as { relativePath: string }).relativePath}`;
                return { success: true, uploadId: 'u1', chunkSizeBytes: 5, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                const result = await finalizing as Record<string, unknown>;
                return { ...result, path };
            }
            return { success: true };
        });
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 3,
            eagerUpload: { sessionId: 's1', config: { uploadLocation: 'workspace', workspaceRelativeDir: '.uploads',
                vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false, maxFileBytes: 3 },
                transferContext: { kind: 'sessionBound', sessionId: 's1',
                    call: async <T,>(method: string, request: unknown): Promise<T> => await call(method, request) as T } },
        }));
        await act(async () => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'folder', name: 'project',
            mimeType: 'inode/directory', entries: [{ relativePath: 'a.txt',
                source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array(3) } }] }] }); });
        await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toBe(true));
        expect(hook.getCurrent().drafts[0]?.status).toBe('uploading');
        expect(hook.getCurrent().drafts[0]?.uploadedPath).toBeUndefined();
        await act(async () => { finish?.(success ? { success: true, path: '.uploads/messages/m1/draft-1/project/a.txt', sizeBytes: 3,
            sha256: 'sha', attachmentHandle: { v: 1, sessionId: 's1', id: 'handle-a' } }
            : { success: false, error: 'transport diagnostic', errorCode: 'permission_denied' }); });
        if (success) {
            await vi.waitFor(() => expect(hook.getCurrent().drafts[0]).toMatchObject({ status: 'uploaded',
                uploadedPath: '.uploads/messages/m1/draft-1/project', uploadedMimeType: 'inode/directory' }));
        } else {
            await vi.waitFor(() => expect(hook.getCurrent().drafts[0]).toMatchObject({ status: 'error',
                error: 'files.transfers.uploadFailed · errors.permissionDenied' }));
            const manager = hook.getCurrent();
            expect(manager.getSendableDraftsSnapshot()).toEqual([]);
            expect(manager.hasSendableAttachments).toBe(false);
            const { prepareComposerSubmissionSnapshot } = await import('@/components/sessions/composer/composerSubmissionCoordinator');
            const token = '[project](happier-ref:attachment:draft-1)';
            expect(prepareComposerSubmissionSnapshot({ text: `Read ${token}`, attachments: [], references: [{
                kind: 'happier.attachment', ref: 'attachment:draft-1', token, start: 5, end: 5 + token.length,
            }] }, manager.getSendableDraftsSnapshot().map(draft => draft.id))).toMatchObject({ text: 'Read ', references: [] });
        }
    });
    it('adds one folder receipt and tray item with per-file size validation', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 3 }));
        let receipts: unknown;
        act(() => {
            receipts = hook.getCurrent().addWebFiles([], { sources: [{
                kind: 'folder', name: 'project', mimeType: 'inode/directory', entries: [
                    { relativePath: 'a.txt', source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array(3) } },
                    { relativePath: 'nested/b.txt', source: { kind: 'memory', name: 'b.txt', bytes: new Uint8Array(3) } },
                ],
            }] });
        });
        expect(receipts).toEqual([expect.objectContaining({ id: 'draft-1', status: 'pending' })]);
        expect(hook.getCurrent().agentInputAttachments).toEqual([expect.objectContaining({ key: 'draft-1', label: 'project' })]);
    });
    it('keeps onRemove defined while uploading so UI can disable it (not hide it)', async () => {
        (globalThis as any).URL ??= {};
        (globalThis as any).URL.createObjectURL ??= () => 'blob:test';
        (globalThis as any).URL.revokeObjectURL ??= () => { };

        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        const file = typeof File === 'function'
            ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
            : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as any);

        act(() => {
            manager().addWebFiles([file as any]);
        });

        expect(manager().drafts).toHaveLength(1);
        expect(manager().drafts[0]!.id).toBe('draft-1');

        act(() => {
            manager().applyDraftPatch('draft-1', { status: 'uploading' });
        });

        expect(manager().agentInputAttachments).toHaveLength(1);
        expect(manager().agentInputAttachments[0]!.status).toBe('uploading');
        expect(manager().agentInputAttachments[0]!.onRemove).toEqual(expect.any(Function));
    });

    it('skips web previews safely when URL globals are unavailable', async () => {
        const originalUrl = globalThis.URL;
        // @ts-expect-error test deletes URL to simulate missing browser global
        delete globalThis.URL;

        try {
            const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
            const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
            const manager = () => hook.getCurrent();

            const file = typeof File === 'function'
                ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
                : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as File);

            expect(() => {
                act(() => {
                    manager().addWebFiles([file]);
                });
            }).not.toThrow();
            expect(manager().agentInputAttachments[0]?.preview).toBeUndefined();
        } finally {
            Object.defineProperty(globalThis, 'URL', {
                configurable: true,
                value: originalUrl,
            });
        }
    });

    it('uses in-memory image preview URIs for clipboard image drafts', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        act(() => {
            manager().addPickedAttachments([{
                kind: 'memory',
                name: 'pasted-image.png',
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'image/png',
                previewUri: 'data:image/png;base64,AQID',
            } as any]);
        });

        expect(manager().agentInputAttachments[0]?.preview).toEqual({
            kind: 'image',
            uri: 'data:image/png;base64,AQID',
            mimeType: 'image/png',
        });
    });

    it('replaces attachment drafts from a failed handoff recovery snapshot', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        const restoredDraft = {
            id: 'restored-draft',
            source: {
                kind: 'memory',
                name: 'retry.txt',
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'text/plain',
            },
            status: 'pending',
        } as const;

        expect(typeof manager().replaceDrafts).toBe('function');

        act(() => {
            manager().replaceDrafts?.([restoredDraft]);
        });

        expect(manager().drafts).toEqual([restoredDraft]);
        expect(manager().agentInputAttachments[0]?.label).toBe('retry.txt');
    });
});
