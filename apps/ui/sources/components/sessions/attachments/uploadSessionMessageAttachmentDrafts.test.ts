import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ComponentProps } from 'react';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { AttachmentsUploadConfig, sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { AttachmentDraft } from './attachmentDraftModel';
import { captureSessionMessageAttachmentDrafts, recordAttachmentTargetUploadCheckpoint,
    uploadSessionMessageAttachmentDrafts, uploadSessionMessageAttachmentDrafts as uploadDrafts } from './uploadSessionMessageAttachmentDrafts';
import { clearSessionAttachmentDrafts, readSessionAttachmentDrafts, writeSessionAttachmentDrafts } from './sessionAttachmentDraftStore';
import type { AttachmentTargetUploadedDraftCheckpoint } from './uploadAttachmentDraftsToSession';
import { createTransferFinalizeRecovery, settleTransferFinalizeRecovery } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import type { SessionAttachmentsUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { TransferFinalizeRecoveryModal } from '@/components/transfers/recovery/TransferFinalizeRecoveryModal';
import type { IModal } from '@/modal';

const modalShow = vi.hoisted(() => vi.fn<IModal['show']>());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modalShow } }).module);

const config: AttachmentsUploadConfig = {
    uploadLocation: 'workspace', workspaceRelativeDir: '.happier/attachments',
    vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false, maxFileBytes: 1024,
};
const target: ExactSessionMachineTargetIdentity = { serverId: 'home-a', accountId: 'account-a', sessionId: 'target-a' };
const executionTarget = { serverId: 'home-a', machineId: 'machine-a' };
const handle: SessionAttachmentHandleV1 = { v: 1, sessionId: target.sessionId, id: 'issued-a' };
function draft(id = 'draft-a'): AttachmentDraft {
    return { id, status: 'uploaded', source: { kind: 'memory', name: `${id}.txt`, bytes: new Uint8Array([1, 2]) },
        uploadedPath: '/source/private.txt', uploadedSizeBytes: 99, sha256: 'source-checkpoint',
        attachmentHandle: { v: 1, sessionId: 'source-session', id: 'source-issued' } };
}
function uploader() {
    return vi.fn<typeof sessionAttachmentsUploadFile>().mockResolvedValue({
        success: true, path: '/target/attachment.txt', sizeBytes: 2, sha256: 'target-digest', attachmentHandle: handle,
    });
}

describe('uploadSessionMessageAttachmentDrafts', () => {
    beforeEach(() => { modalShow.mockReset(); });

    it('retains a missing-source refusal through invocation capture and never uploads empty bytes', async () => {
        const uploadFile = uploader();
        const missing: AttachmentDraft = { id: 'missing', status: 'error', errorCode: 'attachment_source_missing',
            error: 'Please re-attach the missing source.',
            source: { kind: 'memory', name: 'Capture.png', mimeType: 'image/png', bytes: new Uint8Array(),
                savedFile: { kind: 'capture', captureRef: 'deleted-file', content: 'source' } } };
        expect(await uploadDrafts({ target, executionTarget, drafts: [missing], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toBeNull();
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it('reuses an issued checkpoint only for the exact qualified leaf and message attempt after source draft remount', async () => {
        const scope = { serverId: 'source-home', accountId: 'source-account', sessionId: 'source-session', occurrenceId: 'main' };
        writeSessionAttachmentDrafts(scope, [draft()]);
        const checkpoints: AttachmentTargetUploadedDraftCheckpoint[] = [];
        const uploadFile = vi.fn<typeof sessionAttachmentsUploadFile>().mockImplementation(async request => ({
            success: true, path: `/target/${randomUUID()}.txt`, sizeBytes: 2, sha256: 'target-digest',
            attachmentHandle: { v: 1, sessionId: request.sessionId, id: randomUUID() },
        }));
        const onUploadedDraftCheckpoint = async (checkpoint: AttachmentTargetUploadedDraftCheckpoint) => {
            checkpoints.push(checkpoint);
            const current = readSessionAttachmentDrafts(scope);
            writeSessionAttachmentDrafts(scope, current.map(item => item.id === checkpoint.id
                ? { ...item, targetUploadedCheckpoints: recordAttachmentTargetUploadCheckpoint(item.targetUploadedCheckpoints, checkpoint) } : item));
        };
        try {
            const first = await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: readSessionAttachmentDrafts(scope), config,
                messageLocalId: 'message-a', isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint });
            expect(first).toHaveLength(1);
            expect(checkpoints).toEqual([expect.objectContaining({ id: 'draft-a', target, messageLocalId: 'message-a',
                attachmentHandle: first?.[0] })]);
            // This models retry after an uncertain leaf result. Its random issued
            // handle, not an upload-content guess, is the admission identity.
            expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: readSessionAttachmentDrafts(scope), config,
                messageLocalId: 'message-a', isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint })).toEqual(first);
            expect(uploadFile).toHaveBeenCalledTimes(1);
            const migrated = await uploadSessionMessageAttachmentDrafts({ target,
                executionTarget: { ...executionTarget, machineId: 'machine-b' }, drafts: readSessionAttachmentDrafts(scope), config,
                messageLocalId: 'message-a', isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint });
            expect(migrated).toHaveLength(1);
            expect(migrated).not.toEqual(first);
            expect(uploadFile).toHaveBeenCalledTimes(2);
            expect(checkpoints[0]?.executionTarget).toEqual(executionTarget);
            expect(checkpoints[1]?.executionTarget).toEqual({ ...executionTarget, machineId: 'machine-b' });
            for (const changedTarget of [
                { ...target, serverId: 'other-home' }, { ...target, accountId: 'other-account' }, { ...target, sessionId: 'other-session' },
            ]) {
                const next = await uploadSessionMessageAttachmentDrafts({ target: changedTarget,
                    executionTarget: { ...executionTarget, serverId: changedTarget.serverId }, drafts: readSessionAttachmentDrafts(scope), config,
                    messageLocalId: 'message-a', isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint });
                expect(next).toHaveLength(1);
                expect(next).not.toEqual(first);
            }
            const nextAttempt = await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: readSessionAttachmentDrafts(scope), config,
                messageLocalId: 'message-b', isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint });
            expect(nextAttempt).toHaveLength(1);
            expect(nextAttempt).not.toEqual(first);
            const fanoutPeer = { ...target, sessionId: 'fanout-peer' };
            const fanoutHandle = await uploadSessionMessageAttachmentDrafts({ target: fanoutPeer, executionTarget,
                drafts: readSessionAttachmentDrafts(scope), config, messageLocalId: 'message-b',
                isCurrent: () => true, uploadFile, onUploadedDraftCheckpoint });
            expect(fanoutHandle).toHaveLength(1);
            expect(uploadFile).toHaveBeenCalledTimes(7);
            expect(readSessionAttachmentDrafts(scope)[0]).toMatchObject({ uploadedPath: '/source/private.txt',
                attachmentHandle: { sessionId: 'source-session', id: 'source-issued' },
                targetUploadedCheckpoints: [
                    expect.objectContaining({ target, messageLocalId: 'message-b', attachmentHandle: nextAttempt?.[0] }),
                    expect.objectContaining({ target: fanoutPeer, messageLocalId: 'message-b', attachmentHandle: fanoutHandle?.[0] }),
                ] });
        } finally { clearSessionAttachmentDrafts(scope); }
    });

    it('copies target checkpoints at invocation capture and refuses malformed cached handles', async () => {
        const checkpoint = { id: 'draft-a', target: { ...target }, executionTarget: { ...executionTarget }, messageLocalId: 'message-a',
            uploadedPath: '/target/file.txt', uploadedSizeBytes: 2, attachmentHandle: { ...handle } };
        const original = { ...draft(), targetUploadedCheckpoints: [checkpoint] };
        const captured = captureSessionMessageAttachmentDrafts([original]);
        checkpoint.target.accountId = 'replaced-account';
        checkpoint.executionTarget.machineId = 'replaced-machine';
        checkpoint.attachmentHandle.id = 'replaced-handle';
        expect(captured[0]?.targetUploadedCheckpoints).toEqual([{ ...checkpoint, target, executionTarget,
            attachmentHandle: handle }]);
        const uploadFile = uploader();
        for (const invalid of [undefined, { ...handle, sessionId: 'wrong-session' }, { ...handle, forged: true }]) {
            const stale = { ...draft(), targetUploadedCheckpoints: [{ ...checkpoint, target, executionTarget, attachmentHandle: invalid }] };
            expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [stale], config,
                messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toEqual([handle]);
        }
        expect(uploadFile).toHaveBeenCalledTimes(3);
        const legacyCheckpoint = { ...checkpoint, target, attachmentHandle: handle };
        // Simulate an existing process-local checkpoint written before Machine qualification.
        Reflect.deleteProperty(legacyCheckpoint, 'executionTarget');
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget,
            drafts: [{ ...draft(), targetUploadedCheckpoints: [legacyCheckpoint] }], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toEqual([handle]);
        expect(uploadFile).toHaveBeenCalledTimes(4);
    });

    it('reuploads original content for each qualified leaf without transplanting or mutating source checkpoints', async () => {
        const original = draft();
        const sourceBefore = { ...original, source: { ...original.source } };
        const uploadFile = uploader();
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [original], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toEqual([handle]);
        expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: target.sessionId, sessionTarget: target, messageLocalId: 'message-a', file: original.source,
        }));
        const secondTarget = { ...target, serverId: 'home-b', accountId: 'account-b', sessionId: 'target-b' };
        const secondHandle = { ...handle, sessionId: secondTarget.sessionId, id: 'issued-b' };
        uploadFile.mockResolvedValue({ success: true, path: '/other/target.txt', sizeBytes: 2,
            sha256: 'second-digest', attachmentHandle: secondHandle });
        expect(await uploadSessionMessageAttachmentDrafts({ target: secondTarget,
            executionTarget: { ...executionTarget, serverId: secondTarget.serverId }, drafts: [original], config,
            messageLocalId: 'message-b', isCurrent: () => true, uploadFile })).toEqual([secondHandle]);
        expect(original).toEqual(sourceBefore);
    });

    it('captures the entire draft list and memory bytes before the first asynchronous upload', async () => {
        const first = draft();
        const second = draft('draft-b');
        const drafts = [first, second];
        const uploadFile = uploader().mockImplementation(async ({ file }) => {
            if (file.kind !== 'memory') throw new Error('Expected memory source');
            if (file.name === 'draft-a.txt') {
                drafts.splice(1);
                if (second.source.kind === 'memory') second.source.bytes[0] = 9;
            } else {
                expect(Array.from(file.bytes)).toEqual([1, 2]);
            }
            return { success: true, path: '/target/attachment.txt', sizeBytes: 2, sha256: 'target',
                attachmentHandle: { ...handle, id: file.name } };
        });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts, config, messageLocalId: 'message-a',
            isCurrent: () => true, uploadFile })).toEqual([{ ...handle, id: 'draft-a.txt' }, { ...handle, id: 'draft-b.txt' }]);
    });

    it('captures folder memory entries before an asynchronous target send', () => {
        const bytes = new Uint8Array([1, 2]);
        const original: AttachmentDraft = { id: 'folder-draft', status: 'pending', source: { kind: 'folder',
            name: 'project', mimeType: 'inode/directory', directories: ['empty'], entries: [{ relativePath: 'a.txt',
                source: { kind: 'memory', name: 'a.txt', bytes } }] } };
        const captured = captureSessionMessageAttachmentDrafts([original]);
        bytes[0] = 9;
        const source = captured[0]?.source;
        if (source?.kind !== 'folder' || source.entries[0]?.source.kind !== 'memory') throw new Error('Expected folder source');
        expect([...source.entries[0].source.bytes]).toEqual([1, 2]);
    });

    it.each([
        undefined,
        { ...handle, sessionId: 'wrong-session' },
        { ...handle, path: '/untrusted/path' },
    ])('refuses an absent, wrong-session, or non-strict issued handle before starting the next file: %j', async (attachmentHandle) => {
        const original = draft();
        // The transport can return untrusted data; the helper must validate the real strict schema.
        const uploadFile = uploader().mockResolvedValue({ success: true, path: '/target/file.txt', sizeBytes: 2,
            sha256: 'target', attachmentHandle });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [original, draft('draft-b')], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toBeNull();
        expect(uploadFile).toHaveBeenCalledTimes(1);
        expect(original.uploadedPath).toBe('/source/private.txt');
    });

    it('refuses stale work after an asynchronous upload and starts no subsequent file', async () => {
        let current = true;
        const uploadFile = uploader().mockImplementation(async () => {
            current = false;
            return { success: true, path: '/target/a.txt', sizeBytes: 2, sha256: 'target', attachmentHandle: handle };
        });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [draft(), draft('draft-b')], config,
            messageLocalId: 'message-a', isCurrent: () => current, uploadFile })).toBeNull();
        expect(uploadFile).toHaveBeenCalledTimes(1);
    });

    it('does not start an already cancelled invocation and refuses cancellation during upload', async () => {
        const controller = new AbortController();
        const uploadFile = uploader();
        controller.abort();
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [draft()], config, messageLocalId: 'message-a',
            signal: controller.signal, isCurrent: () => true, uploadFile })).toBeNull();
        expect(uploadFile).not.toHaveBeenCalled();
        const active = new AbortController();
        uploadFile.mockImplementation(async ({ signal }) => {
            expect(signal).toBe(active.signal);
            active.abort();
            return { success: true, path: '/target/a.txt', sizeBytes: 2, sha256: 'target', attachmentHandle: handle };
        });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [draft(), draft('draft-b')], config,
            messageLocalId: 'message-a', signal: active.signal, isCurrent: () => true, uploadFile })).toBeNull();
        expect(uploadFile).toHaveBeenCalledTimes(1);
    });

    it('uses existing recovery presentation and refuses unavailable recovery without losing the source', async () => {
        modalShow.mockImplementation(() => '');
        const original = draft();
        const uploadFile = uploader().mockResolvedValue({ success: false, error: 'Finalize uncertain',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery: createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({ expiresAt: Date.now() + 60_000,
                retryFinalize: async () => settleTransferFinalizeRecovery({ status: 'unavailable', reason: 'expired', error: 'Expired' }),
                discard: async () => settleTransferFinalizeRecovery({ status: 'discarded' }),
            }) });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [original], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toBeNull();
        expect(modalShow).toHaveBeenCalled();
        expect(original).toEqual(draft());
    });

    it('accepts the actual target handle returned by ordinary finalize recovery', async () => {
        modalShow.mockImplementation((config) => {
            // Modal presentation is the genuine UI boundary; the recovery loop and continuation remain real.
            const props = config.props as ComponentProps<typeof TransferFinalizeRecoveryModal>;
            props.onResolve('retry_finalize');
            return 'recovery-modal';
        });
        const uploadFile = uploader().mockResolvedValue({ success: false, error: 'Finalize uncertain',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery: createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({ expiresAt: Date.now() + 60_000,
                retryFinalize: async () => settleTransferFinalizeRecovery({ status: 'finalized', response: {
                    success: true, path: '/target/recovered.txt', sizeBytes: 2, sha256: 'recovered', attachmentHandle: handle,
                } }),
                discard: async () => settleTransferFinalizeRecovery({ status: 'discarded' }),
            }) });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [draft()], config,
            messageLocalId: 'message-a', isCurrent: () => true, uploadFile })).toEqual([handle]);
    });

    it('cancels an unanswered recovery choice with the composer invocation and retains its source for retry', async () => {
        modalShow.mockImplementation(() => 'recovery-modal');
        const original = draft();
        const recovery = createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({ expiresAt: Date.now() + 60_000,
            retryFinalize: async () => settleTransferFinalizeRecovery({ status: 'finalized', response: {
                success: true, path: '/target/recovered.txt', sizeBytes: 2, sha256: 'recovered', attachmentHandle: handle,
            } }),
            discard: async () => settleTransferFinalizeRecovery({ status: 'discarded' }),
        });
        const uploadFile = uploader().mockResolvedValue({ success: false, error: 'Finalize uncertain',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', recovery });
        const controller = new AbortController();
        let settled = false;
        const pending = uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [original], config,
            messageLocalId: 'message-a', signal: controller.signal, isCurrent: () => true, uploadFile })
            .then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(modalShow).toHaveBeenCalled());
        controller.abort();
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(pending).resolves.toBeNull();
        expect(original).toEqual(draft());
        expect(recovery.isActionable()).toBe(true);
        modalShow.mockImplementation(config => {
            const props = config.props as ComponentProps<typeof TransferFinalizeRecoveryModal>;
            props.onResolve('retry_finalize');
            return 'fresh-modal';
        });
        await expect(uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [original], config,
            messageLocalId: 'message-a', signal: new AbortController().signal, isCurrent: () => true, uploadFile })).resolves.toEqual([handle]);
    });

    it('does not retry finalization from a recovery dialog after the invocation becomes stale', async () => {
        let current = true;
        let retried = false;
        modalShow.mockImplementation((config) => {
            const props = config.props as ComponentProps<typeof TransferFinalizeRecoveryModal>;
            current = false;
            props.onResolve('retry_finalize');
            return 'recovery-modal';
        });
        const uploadFile = uploader().mockResolvedValue({ success: false, error: 'Finalize uncertain',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery: createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({ expiresAt: Date.now() + 60_000,
                retryFinalize: async () => {
                    retried = true;
                    return settleTransferFinalizeRecovery({ status: 'finalized', response: {
                        success: true, path: '/target/recovered.txt', sizeBytes: 2, sha256: 'recovered', attachmentHandle: handle,
                    } });
                },
                discard: async () => settleTransferFinalizeRecovery({ status: 'discarded' }),
            }) });
        expect(await uploadSessionMessageAttachmentDrafts({ target, executionTarget, drafts: [draft()], config,
            messageLocalId: 'message-a', isCurrent: () => current, uploadFile })).toBeNull();
        expect(retried).toBe(false);
    });
});
