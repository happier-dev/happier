import * as React from 'react';
import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { StoredAttachmentPayloadV1Schema, readAttachmentPayloadFilesV1, type StoredAttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';
import type { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { decodeBase64 } from '@/encryption/base64';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionRepository } from './discussionRepository';
import { readRegisteredDiscussionRepository, subscribeRegisteredDiscussionRepository } from './discussionRepositoryRegistry';

type ResourceInput = Readonly<{
    repository: DiscussionRepository;
    client: Pick<ReturnType<typeof createDiscussionClient>, 'readAttachment'>;
    discussionId: string;
    messageId: string;
    throughSeq?: number;
}>;

export type DiscussionAttachmentPreviewInput = ResourceInput & Readonly<{
    reference: BinaryBlobReferenceV1;
    name: string;
    enabled: boolean;
}>;

function cryptoBasis(input: Pick<ResourceInput, 'repository' | 'discussionId'>): string | null {
    const summary = input.repository.getSnapshot().threads[input.discussionId]?.summary;
    return summary?.keyReadiness ? JSON.stringify([summary.encryptionMode, summary.dataEncryptionKey, summary.keyReadiness]) : null;
}

function captureResource(input: ResourceInput) {
    const { repository } = input;
    const address = { serverId: repository.scope.serverId };
    const basis = cryptoBasis(input);
    const operation = repository.captureReadOperation(input.discussionId);
    let retired = false;
    const isCurrent = () => {
        if (!retired && (basis === null || !operation.isCurrent() || cryptoBasis(input) !== basis
            || readRegisteredDiscussionRepository(repository.scope, address) !== repository)) retired = true;
        return !retired;
    };
    const lifetime = { isCurrent, onRetire: (listener: () => void) => {
        let notified = false;
        const check = () => { if (!notified && !isCurrent()) { notified = true; listener(); } };
        const unsubscribe = subscribeRegisteredDiscussionRepository(repository.scope, address, check);
        check();
        return { dispose: unsubscribe };
    } };
    const assertCurrent = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!isCurrent()) throw Object.assign(new Error('Discussion attachment is unavailable'), { code: 'discussion_content_unavailable' });
    };
    const readBytes = async (reference: BinaryBlobReferenceV1, signal: AbortSignal) => {
        assertCurrent(signal);
        try {
            const result = await input.client.readAttachment({ discussionId: input.discussionId, messageId: input.messageId,
                blobId: reference.blobId, ...(input.throughSeq === undefined ? {} : { throughSeq: input.throughSeq }) }, signal);
            if (result.kind !== 'succeeded') throw Object.assign(new Error('Discussion attachment is unavailable'), {
                code: result.kind === 'failed' ? result.errorCode : 'discussion_content_unavailable' });
            assertCurrent(signal);
            const value = result.value;
            if ('removedByAccountId' in value) throw Object.assign(new Error('Discussion attachment was removed'), { code: 'discussion_attachment_removed' });
            if (value.blobId !== reference.blobId || value.sha256 !== reference.sha256 || value.sizeBytes !== reference.sizeBytes || value.mime !== reference.mime) {
                throw Object.assign(new Error('Discussion attachment identity changed'), { code: 'discussion_content_unavailable' });
            }
            return decodeBase64(value.bytesBase64);
        } catch (error) {
            // Only the captured operation may delegate a denial to the repository's canonical purge rules.
            if (isCurrent() && error instanceof Error && 'code' in error && typeof error.code === 'string') operation.observeFailure(error.code);
            throw error;
        }
    };
    return { lifetime, readBytes };
}

function previewInput(input: DiscussionAttachmentPreviewInput, resource: ReturnType<typeof captureResource>): UseFilePreviewSourceInput {
    return { enabled: input.enabled,
        cacheScopeId: serverAccountScopedResourceKey(input.repository.scope, 'discussion-attachments', input.discussionId),
        cacheKey: JSON.stringify([input.messageId, input.reference.blobId, input.reference.sha256]),
        mimeType: input.reference.mime, sizeBytes: input.reference.sizeBytes,
        source: { kind: 'resource', id: serverAccountScopedResourceKey(input.repository.scope, 'discussion', input.discussionId, input.messageId, input.reference.blobId),
            name: input.name, readBytes: signal => resource.readBytes(input.reference, signal), lifetime: resource.lifetime } };
}

export function createDiscussionAttachmentPreviewInput(input: DiscussionAttachmentPreviewInput): UseFilePreviewSourceInput {
    return previewInput(input, captureResource(input));
}

function useResourceAdmission(input: ResourceInput): string | null {
    const { repository, discussionId } = input;
    const subscribe = React.useCallback((listener: () => void) => subscribeRegisteredDiscussionRepository(repository.scope,
        { serverId: repository.scope.serverId }, listener), [repository]);
    const read = React.useCallback(() => readRegisteredDiscussionRepository(repository.scope, { serverId: repository.scope.serverId }) === repository
        ? JSON.stringify([repository.getReadCurrentnessKey(discussionId), cryptoBasis({ repository, discussionId })]) : null, [repository, discussionId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Message arrivals do not churn a preview; grant/key/Account retirement does. */
export function useDiscussionAttachmentPreviewInput(input: DiscussionAttachmentPreviewInput): UseFilePreviewSourceInput {
    const admission = useResourceAdmission(input);
    return React.useMemo(() => createDiscussionAttachmentPreviewInput(input), [input.repository, input.client,
        input.discussionId, input.messageId, input.throughSeq, input.reference.blobId, input.reference.sha256,
        input.reference.mime, input.reference.sizeBytes, input.name, input.enabled, admission]);
}

/** The original shared file/folder tree is presentation data, never a Machine path or ZIP. */
export function createDiscussionAttachmentResource(input: ResourceInput & Readonly<{ attachment: StoredAttachmentPayloadV1 }>) {
    const attachment = StoredAttachmentPayloadV1Schema.parse(input.attachment);
    const resource = captureResource(input);
    const files = new Map(readAttachmentPayloadFilesV1(attachment).map(file => [file.blobId, file]));
    const requireFile = (blobId: string) => {
        const file = files.get(blobId);
        if (!file) throw Object.assign(new Error('Attachment leaf is unavailable'), { code: 'discussion_content_unavailable' });
        return file;
    };
    return { attachment, lifetime: resource.lifetime,
        readFile: (blobId: string, signal: AbortSignal) => resource.readBytes(requireFile(blobId), signal),
        previewFile: (blobId: string, name: string, enabled: boolean) => previewInput({ ...input,
            reference: requireFile(blobId), name, enabled }, resource) };
}

export function useDiscussionAttachmentResource(input: ResourceInput & Readonly<{ attachment: StoredAttachmentPayloadV1 }>) {
    const admission = useResourceAdmission(input);
    return React.useMemo(() => createDiscussionAttachmentResource(input), [input.repository, input.client,
        input.discussionId, input.messageId, input.throughSeq, input.attachment, admission]);
}

/** One message's attachments, each with its own captured read; a thread row renders them together. */
export function useDiscussionAttachmentResources(input: ResourceInput & Readonly<{ attachments: readonly StoredAttachmentPayloadV1[] }>) {
    const admission = useResourceAdmission(input);
    return React.useMemo(() => new Map(input.attachments.map(attachment => [attachment.id,
        createDiscussionAttachmentResource({ ...input, attachment })] as const)), [input.repository, input.client,
        input.discussionId, input.messageId, input.throughSeq, input.attachments, admission]);
}
