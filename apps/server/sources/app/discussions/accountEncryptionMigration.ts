import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { DiscussionMessageContentV1StoredSchema, DiscussionTitleV1StoredSchema, readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { AccountEncryptionMigrateDiscussionsDirectiveV1, DiscussionAccountEncryptionInventoryV1 } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectResourceRecipientEnvelope } from '@/app/teams/resourceGrantAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { resolveDiscussionAudienceInTx } from './access';
import { readDiscussionRecipientCensusInTx } from './accessService';
import { markDiscussionReadersChangedInTx } from './changes';
import { discussionConversionAttachmentCustody, discussionConversionAttachmentKey, type PreparedDiscussionAttachmentConversions } from './attachmentEncryptionConversion';
import { discussionAttachmentCandidateStorageKey, discussionAttachmentRejectedUploadReuseKey } from './attachmentService';

function readRows(tx: Tx, accountId: string) {
    return tx.discussion.findMany({ where: { ownerAccountId: accountId }, orderBy: { id: 'asc' },
        select: { id: true, encryptionMode: true, dataEncryptionKey: true, titleContent: true,
            messages: { orderBy: { id: 'asc' }, select: { id: true, content: true,
                attachments: { orderBy: { blobId: 'asc' }, select: { blobId: true, messageId: true, storageKey: true, encryptionMode: true,
                    storedSizeBytes: true, removedByAccountId: true } } } },
            keyEnvelopes: { orderBy: { recipientAccountId: 'asc' }, select: { recipientAccountId: true,
                encryptedDataKey: true, recipientContentPublicKeyFingerprint: true } } } });
}

/** Owner-only inventory includes archived resources and every retained message. */
export async function readDiscussionAccountEncryptionInventoryInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<DiscussionAccountEncryptionInventoryV1> {
    const items: DiscussionAccountEncryptionInventoryV1['items'] = [];
    for (const row of await readRows(tx, input.accountId)) {
        const census = await readDiscussionRecipientCensusInTx(tx, { actorAccountId: input.accountId,
            discussionId: row.id, authentication: input.authentication });
        if (!census.ok) throw new Error(census.error);
        items.push({ discussionId: row.id, dataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)),
            titleContent: StrictSessionStoredMessageContentEnvelopeSchema.parse(row.titleContent),
            messages: row.messages.map(message => ({ id: message.id,
                content: StrictSessionStoredMessageContentEnvelopeSchema.parse(message.content),
                ...removedAttachmentIds(message.attachments),
                attachments: message.attachments.filter(row => row.removedByAccountId === null).map(attachment => {
                    const encryptionMode = attachment.encryptionMode;
                    if ((encryptionMode !== 'plain' && encryptionMode !== 'e2ee') || encryptionMode !== row.encryptionMode) {
                        throw new Error('Discussion attachment mode unavailable');
                    }
                    return { blobId: attachment.blobId, encryptionMode, storedSizeBytes: Number(attachment.storedSizeBytes) };
                }) })), recipients: census.value });
    }
    return { items };
}

function removedAttachmentIds(attachments: readonly { blobId: string; removedByAccountId: string | null }[]) {
    const removed = attachments.filter(row => row.removedByAccountId !== null).map(row => row.blobId);
    return removed.length ? { removedAttachmentBlobIds: removed } : {};
}

function matchesMode(content: unknown, mode: 'plain' | 'e2ee', title = false): boolean {
    const parsed = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(content);
    if (!parsed.success || parsed.data.t !== (mode === 'plain' ? 'plain' : 'encrypted')) return false;
    return parsed.data.t === 'encrypted' || (title ? DiscussionTitleV1StoredSchema : DiscussionMessageContentV1StoredSchema).safeParse(parsed.data.v).success;
}
function keyMatchesMode(key: string, mode: 'plain' | 'e2ee'): boolean {
    if (mode === 'plain') return key === ARTIFACT_PLAIN_DATA_KEY_MARKER;
    try { return parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(key)) !== null; }
    catch { return false; }
}

/** Read-only exact post-state matching; a replay cannot rewrite or republish. */
export async function matchDiscussionAccountEncryptionMigrationPostStateInTx(tx: Tx, input: Readonly<{
    accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateDiscussionsDirectiveV1;
    preparedAttachments?: PreparedDiscussionAttachmentConversions;
}>): Promise<{ status: 'matched' | 'mismatch' }> {
    const rows = await readRows(tx, input.accountId);
    const items = new Map(input.directive?.items.map(item => [item.discussionId, item]));
    if (items.size !== (input.directive?.items.length ?? 0) || items.size !== rows.length) return { status: 'mismatch' };
    for (const row of rows) {
        const item = items.get(row.id);
        if (!item || row.encryptionMode !== input.toMode || !isDeepStrictEqual(row.titleContent, item.titleContent)
            || privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== item.dataEncryptionKey) return { status: 'mismatch' };
        const messages = new Map(item.messages.map(message => [message.id, message]));
        if (messages.size !== item.messages.length || messages.size !== row.messages.length
            || row.messages.some(message => !isDeepStrictEqual(message.content, messages.get(message.id)?.content))) return { status: 'mismatch' };
        for (const message of row.messages) {
            const attachments = messages.get(message.id)?.attachments ?? [];
            const currentByBlobId = new Map(message.attachments.filter(row => row.removedByAccountId === null).map(row => [row.blobId, row]));
            if (attachments.length !== currentByBlobId.size || new Set(attachments.map(attachment => attachment.blobId)).size !== attachments.length) return { status: 'mismatch' };
            for (const attachment of attachments) {
                const current = currentByBlobId.get(attachment.blobId);
                const prepared = input.preparedAttachments?.get(discussionConversionAttachmentKey(message.id, attachment.blobId));
                if (!current || current.encryptionMode !== input.toMode || !prepared
                    || current.storageKey !== discussionAttachmentCandidateStorageKey(attachment.blobId, attachment.content.uploadId)
                    || prepared.target.row.storageKey !== current.storageKey || prepared.target.row.storedSizeBytes !== current.storedSizeBytes
                    || prepared.target.contentSha256 !== attachment.content.contentSha256) return { status: 'mismatch' };
            }
        }
        const envelopes = new Map(item.recipientKeyEnvelopes.map(envelope => [envelope.recipientAccountId, envelope]));
        if (envelopes.size !== row.keyEnvelopes.length || row.keyEnvelopes.some(envelope => {
            const expected = envelopes.get(envelope.recipientAccountId);
            return !expected || expected.encryptedDataKey !== privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey))
                || expected.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint;
        })) return { status: 'mismatch' };
    }
    return { status: 'matched' };
}

/** Conversion participates in the incumbent Account transaction and source fence. */
export async function migrateDiscussionAccountEncryptionInTx(tx: Tx, input: Readonly<{
    accountId: string; fromMode: 'plain' | 'e2ee'; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateDiscussionsDirectiveV1;
    preparedAttachments?: PreparedDiscussionAttachmentConversions;
}>): Promise<{ status: 'applied' | 'migration_incomplete' }> {
    const rows = await readRows(tx, input.accountId);
    const items = new Map(input.directive?.items.map(item => [item.discussionId, item]));
    if (items.size !== (input.directive?.items.length ?? 0) || items.size !== rows.length) return { status: 'migration_incomplete' };
    const audiences = new Map<string, readonly string[]>();
    // Validate the entire source and target census before changing any resource.
    for (const row of rows) {
        const item = items.get(row.id);
        if (!item || row.encryptionMode !== input.fromMode || !isDeepStrictEqual(row.titleContent, item.expectedTitleContent)
            || privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== item.expectedDataEncryptionKey
            || !keyMatchesMode(item.expectedDataEncryptionKey, input.fromMode) || !keyMatchesMode(item.dataEncryptionKey, input.toMode)
            || !matchesMode(row.titleContent, input.fromMode, true) || !matchesMode(item.titleContent, input.toMode, true)) return { status: 'migration_incomplete' };
        const messages = new Map(item.messages.map(message => [message.id, message]));
        if (messages.size !== item.messages.length || messages.size !== row.messages.length
            || row.messages.some(message => {
                const replacement = messages.get(message.id);
                return !replacement || !isDeepStrictEqual(message.content, replacement.expectedContent)
                    || !matchesMode(message.content, input.fromMode) || !matchesMode(replacement.content, input.toMode);
            })) return { status: 'migration_incomplete' };
        for (const message of row.messages) {
            const replacement = messages.get(message.id)!;
            const attachments = replacement.attachments ?? [];
            const attachmentIds = new Set(attachments.map(attachment => attachment.blobId));
            const sourceByBlobId = new Map(message.attachments.filter(row => row.removedByAccountId === null).map(row => [row.blobId, row]));
            if (attachments.length !== sourceByBlobId.size || attachmentIds.size !== attachments.length) return { status: 'migration_incomplete' };
            const messageAttachmentIds = new Set(message.attachments.map(row => row.blobId));
            const sourceEnvelope = StrictSessionStoredMessageContentEnvelopeSchema.parse(message.content);
            const sourceReferences = sourceEnvelope.t === 'plain'
                ? readDiscussionAttachmentReferencesV1(DiscussionMessageContentV1StoredSchema.parse(sourceEnvelope.v)) : null;
            const targetReferences = replacement.content.t === 'plain'
                ? readDiscussionAttachmentReferencesV1(DiscussionMessageContentV1StoredSchema.parse(replacement.content.v)) : null;
            for (const references of [sourceReferences, targetReferences]) {
                if (references && (new Set(references.map(reference => reference.blobId)).size !== messageAttachmentIds.size
                    || references.some(reference => !messageAttachmentIds.has(reference.blobId)))) return { status: 'migration_incomplete' };
            }
            const targetByBlobId = new Map(targetReferences?.map(reference => [reference.blobId, reference]));
            const sourceReferenceByBlobId = new Map(sourceReferences?.map(reference => [reference.blobId, reference]));
            for (const attachment of attachments) {
                const source = sourceByBlobId.get(attachment.blobId);
                const candidate = input.preparedAttachments?.get(discussionConversionAttachmentKey(message.id, attachment.blobId));
                if (!source || !candidate || source.encryptionMode !== input.fromMode
                    || candidate.source.messageId !== message.id || candidate.source.blobId !== source.blobId
                    || candidate.source.storageKey !== source.storageKey || candidate.source.encryptionMode !== source.encryptionMode
                    || candidate.source.storedSizeBytes !== source.storedSizeBytes || candidate.expectedContentSha256 !== attachment.expectedContentSha256
                    || candidate.target.accountId !== input.accountId || candidate.target.row.messageId !== message.id
                    || candidate.target.row.blobId !== source.blobId || !candidate.target.candidate
                    || candidate.target.row.encryptionMode !== input.toMode || attachment.content.t !== (input.toMode === 'plain' ? 'plain' : 'encrypted')
                    || candidate.target.row.storageKey !== discussionAttachmentCandidateStorageKey(source.blobId, attachment.content.uploadId)
                    || candidate.target.contentSha256 !== attachment.content.contentSha256
                    || !await tx.uploadedFile.findFirst({ where: { accountId: input.accountId, path: candidate.target.row.storageKey,
                        reuseKey: discussionConversionAttachmentCustody(candidate.target.row) } })) return { status: 'migration_incomplete' };
                const targetReference = targetByBlobId.get(source.blobId);
                const sourceReference = sourceReferenceByBlobId.get(source.blobId);
                if (sourceReference && (sourceReference.sha256 !== candidate.expectedContentSha256
                    || sourceReference.sizeBytes !== candidate.sourceSizeBytes)) return { status: 'migration_incomplete' };
                if (targetReference && (targetReference.sizeBytes !== candidate.target.sizeBytes
                    || targetReference.sha256 !== candidate.target.contentSha256)) return { status: 'migration_incomplete' };
            }
        }
        const audience = await resolveDiscussionAudienceInTx(tx, row.id);
        audiences.set(row.id, audience);
        if (input.toMode === 'plain' && item.recipientKeyEnvelopes.length > 0) return { status: 'migration_incomplete' };
        const accounts = await tx.account.findMany({ where: { id: { in: audience.filter(id => id !== input.accountId) } }, select: RECIPIENT_READINESS_SELECT });
        const byAccountId = new Map(accounts.map(account => [account.id, account]));
        const readyRecipients = accounts.filter(account => deriveAccountRecipientEnvelopeReadinessFromRow(account).status === 'available');
        if (input.toMode === 'e2ee' && readyRecipients.length !== item.recipientKeyEnvelopes.length) return { status: 'migration_incomplete' };
        const recipientIds = new Set<string>();
        for (const envelope of item.recipientKeyEnvelopes) {
            const account = byAccountId.get(envelope.recipientAccountId);
            if (recipientIds.has(envelope.recipientAccountId) || envelope.recipientAccountId === input.accountId
                || !audience.includes(envelope.recipientAccountId) || !account
                || !projectResourceRecipientEnvelope(account, { ...envelope, encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) })) return { status: 'migration_incomplete' };
            recipientIds.add(envelope.recipientAccountId);
        }
    }
    for (const row of rows) {
        const item = items.get(row.id)!;
        await tx.discussion.update({ where: { id: row.id }, data: { encryptionMode: input.toMode,
            dataEncryptionKey: privacyKit.decodeBase64(item.dataEncryptionKey), titleContent: item.titleContent } });
        for (const message of item.messages) await tx.discussionMessage.update({ where: { id: message.id }, data: { content: message.content } });
        for (const message of item.messages) for (const attachment of message.attachments ?? []) {
            const prepared = input.preparedAttachments!.get(discussionConversionAttachmentKey(message.id, attachment.blobId))!;
            await tx.uploadedFile.upsert({ where: { accountId_path: { accountId: input.accountId, path: prepared.source.storageKey } },
                create: { accountId: input.accountId, path: prepared.source.storageKey, reuseKey: discussionAttachmentRejectedUploadReuseKey(attachment.blobId) },
                update: { reuseKey: discussionAttachmentRejectedUploadReuseKey(attachment.blobId) } });
            const migrated = await tx.discussionAttachment.updateMany({ where: { blobId: attachment.blobId, messageId: message.id,
                storageKey: prepared.source.storageKey, encryptionMode: input.fromMode, storedSizeBytes: prepared.source.storedSizeBytes },
                data: { storageKey: prepared.target.row.storageKey, encryptionMode: input.toMode, storedSizeBytes: prepared.target.row.storedSizeBytes } });
            const consumed = await tx.uploadedFile.deleteMany({ where: { accountId: input.accountId, path: prepared.target.row.storageKey,
                reuseKey: discussionConversionAttachmentCustody(prepared.target.row) } });
            if (migrated.count !== 1 || consumed.count !== 1) throw new Error('Discussion attachment migration source changed');
        }
        await tx.discussionKeyEnvelope.deleteMany({ where: { discussionId: row.id } });
        for (const envelope of item.recipientKeyEnvelopes) await tx.discussionKeyEnvelope.create({ data: { discussionId: row.id,
            ...envelope, encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: row.id, additionalAccountIds: audiences.get(row.id), accessChanged: true });
    }
    return { status: 'applied' };
}
