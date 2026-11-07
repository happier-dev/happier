import { isDeepStrictEqual } from 'node:util';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { DiscussionMessageContentV1Schema, DiscussionProducerV1Schema, DiscussionProducerV1StoredSchema, DiscussionTitleV1Schema, isDiscussionDocEditProposalContentV1, readDiscussionMentionedParticipantIdsV1, readDiscussionAttachmentReferencesV1, type DiscussionProducerV1 } from '@happier-dev/protocol/discussions/content';
import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { DiscussionCreateRequestV1Schema, DiscussionPostRequestV1Schema, type DiscussionCreateRequestV1, type DiscussionCreateResponseV1, type DiscussionDetailsResponseV1, type DiscussionPostRequestV1, type DiscussionPostResponseV1 } from '@happier-dev/protocol/discussions/api';
import { serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { DiscussionAnchorV1Schema, type DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { computeSessionMutationEqualityPlainDigestV1, SessionMutationEqualityEvidenceV1Schema, type SessionMutationEqualityEvidenceV1 } from '@happier-dev/protocol/sessions/mutations/sessionMutationEqualityV1';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { evaluateCurrentResourceContextPairInTx } from '@/app/session/access/sessionContextInjection';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { acquireArtifactPublicationLocksInTx, resolveArtifactPublicationAdmissionIntent } from '@/app/artifacts/artifactAccessService';
import { beforeAccountChangePublication } from '@/app/changes/markAccountChanged';
import { acquireDiscussionMutationAccountsInTx, prepareDiscussionMutationAccounts, isDiscussionCredentialCurrentInTx, resolveDiscussionContextInTx, filterAccountsWithCurrentDiscussionReadAccessInTx, discussionContextStorageAdapter, newDiscussionContextStorageAdapter, type DiscussionContext } from './access';
import { fenceSessionAccountCursorAudienceInTx, readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { admitDiscussionDocSourceInTx, readDiscussionDocSourceAuthorityAccountIdsInTx, resolveDiscussionDocSourcesInTx, resolveDiscussionDocTargetInTx, validateDiscussionDocContentSource } from './docPassages';
import { admitDiscussionSecondOpinionSourceInTx } from './secondOpinion';
import { validateInitialDiscussionGrantsInTx, applyInitialDiscussionGrantsInTx, inviteDiscussionParticipantInTx } from './accessService';
import { markDiscussionReadersChangedInTx, scheduleDiscussionBadgeRefreshInTx } from './changes';
import { detachDiscussionFollowSourceInTx, attachDiscussionFollowSourceInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import { withdrawDiscussionInputRepliesInTx } from '@/app/session/messages/sessionMessageReply';
import { DISCUSSION_MESSAGE_SELECT, projectDiscussionAccountActorsInTx, projectDiscussionMessageV1, validateDiscussionStoredContent, admitDiscussionStoredMessage, type AdmittedDiscussionMessageRow, type DiscussionMessageRow } from './projection';
import { projectDiscussionForViewerInTx, readDiscussionRowInTx } from './queries';
import { initializeDiscussionReadBaselinesInTx } from './readState';
import { DiscussionCreationRejectedError, reconcileDiscussionCreationIdentityRace } from './createIdentityReconciliation';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { readSessionInputDiscussionReplyReturnInTx, settleSessionInputDiscussionReplyReturnInTx } from '@/app/session/messages/sessionMessageReply';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import type { WorkflowDiscussionOriginV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { workflowInvocationObservationRunWhere } from '@/app/workflows/workflowRunAccess';
import { SessionMessageDiscussionReplyReturnV1Schema, type SessionMessageDiscussionReplyReturnV1, type SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { admitDiscussionAttachmentsInTx, bindDiscussionAttachmentsInTx, type PreparedDiscussionAttachmentWrite } from './attachmentService';

type Actor = Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;
type ExactDiscussion = Actor & Readonly<{ discussionId: string }>;
type StorageMode = DiscussionContext['storageMode'];
type Intent = Readonly<{
    localId: string; content: StrictSessionStoredMessageContentEnvelope; mentionedAccountIds: readonly string[];
    mentionedSessionIds: readonly string[];
    docEditProposal: boolean;
    plainAttachmentReferences: readonly BinaryBlobReferenceV1[] | null;
    replyTarget?: DiscussionReplyTargetV1; evidence: SessionMutationEqualityEvidenceV1;
}>;
type InvalidIntent = Readonly<{ error: 'discussion_invalid_content' | 'discussion_encryption_mode_mismatch' | 'discussion_invalid_mention' }>;

/** Plain digests and encrypted key-holder tags share the canonical semantic serializer. */
function messageIntent(mode: StorageMode, request: DiscussionPostRequestV1): Intent | InvalidIntent {
    if (request.content.t !== (mode === 'plain' ? 'plain' : 'encrypted')) return { error: 'discussion_encryption_mode_mismatch' };
    const ids = [...new Set(request.mentionedAccountIds)];
    const sessionIds = [...new Set(request.mentionedSessionIds ?? [])].sort();
    const base = { localId: request.localId, content: request.content, mentionedAccountIds: ids,
        mentionedSessionIds: sessionIds,
        ...(request.replyTarget ? { replyTarget: request.replyTarget } : {}) };
    if (request.content.t === 'encrypted') {
        return request.requestEqualityEvidenceV1?.kind === 'e2eeTag'
            ? { ...base, docEditProposal: request.docEditProposal === true, plainAttachmentReferences: null,
                evidence: request.requestEqualityEvidenceV1 } : { error: 'discussion_invalid_content' };
    }
    const content = DiscussionMessageContentV1Schema.safeParse(request.content.v);
    if (!content.success) return { error: 'discussion_invalid_content' };
    const docEditProposal = isDiscussionDocEditProposalContentV1(content.data);
    if (request.docEditProposal && !docEditProposal) return { error: 'discussion_invalid_content' };
    const mentions = readDiscussionMentionedParticipantIdsV1(content.data);
    if (!isDeepStrictEqual(mentions.mentionedSessionIds, sessionIds)) return { error: 'discussion_invalid_mention' };
    return { ...base, docEditProposal, plainAttachmentReferences: readDiscussionAttachmentReferencesV1(content.data),
        mentionedAccountIds: [...new Set([...ids, ...mentions.mentionedAccountIds])], evidence: { kind: 'plainDigest', digest: computeSessionMutationEqualityPlainDigestV1(
        serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: content.data, mentionedAccountIds: ids, mentionedSessionIds: sessionIds,
            attachments: request.attachments, ...(request.replyTarget ? { replyTarget: request.replyTarget } : {}) }),
    ) } };
}

function creationEvidence(mode: StorageMode, request: DiscussionCreateRequestV1): SessionMutationEqualityEvidenceV1 | InvalidIntent {
    if (request.titleContent.t !== (mode === 'plain' ? 'plain' : 'encrypted')) return { error: 'discussion_encryption_mode_mismatch' };
    if (request.titleContent.t === 'encrypted') return request.creationEqualityEvidenceV1?.kind === 'e2eeTag'
        ? request.creationEqualityEvidenceV1 : { error: 'discussion_invalid_content' };
    const title = DiscussionTitleV1Schema.safeParse(request.titleContent.v);
    const content = DiscussionMessageContentV1Schema.safeParse(request.firstMessage.content.t === 'plain' ? request.firstMessage.content.v : undefined);
    if (!title.success || !content.success) return { error: 'discussion_invalid_content' };
    return { kind: 'plainDigest', digest: computeSessionMutationEqualityPlainDigestV1(serializeDiscussionMutationEqualityIntentV1({
        kind: 'create', title: title.data,
        ...(request.anchor ? { anchor: request.anchor } : {}), ...(request.participants ? { participants: request.participants } : {}),
        firstMessage: { localId: request.firstMessage.localId, content: content.data, mentionedAccountIds: request.firstMessage.mentionedAccountIds,
            mentionedSessionIds: request.firstMessage.mentionedSessionIds,
            attachments: request.firstMessage.attachments,
            ...(request.firstMessage.replyTarget ? { replyTarget: request.firstMessage.replyTarget } : {}) },
    })) };
}

function equalEvidence(stored: unknown, next: SessionMutationEqualityEvidenceV1): boolean {
    const parsed = SessionMutationEqualityEvidenceV1Schema.safeParse(stored);
    if (!parsed.success || parsed.data.kind !== next.kind) return false;
    return next.kind === 'plainDigest' ? parsed.data.kind === 'plainDigest' && parsed.data.digest === next.digest
        : parsed.data.kind === 'e2eeTag' && parsed.data.tag === next.tag;
}

function equalProducer(stored: unknown, next: DiscussionProducerV1 | undefined): boolean {
    if (stored == null) return next === undefined;
    const parsed = DiscussionProducerV1StoredSchema.safeParse(stored);
    return next !== undefined && parsed.success && isDeepStrictEqual(parsed.data, next);
}

async function readMessageByLocalIdInTx(tx: Tx, discussionId: string, localId: string) {
    return tx.discussionMessage.findUnique({ where: { discussionId_localId: { discussionId, localId } }, select: { ...DISCUSSION_MESSAGE_SELECT, requestEqualityEvidenceV1: true } });
}

async function insertMessageInTx(tx: Tx, input: Readonly<{
    discussionId: string; actorAccountId: string; seq: number; intent: Intent; producer?: DiscussionProducerV1; at: Date;
    addressedSessionIds?: readonly string[];
    watcherSessionIds?: readonly string[];
}>): Promise<DiscussionMessageRow> {
    const message = await tx.discussionMessage.create({ data: {
        discussionId: input.discussionId, authorAccountId: input.actorAccountId, seq: input.seq,
        localId: input.intent.localId, requestEqualityEvidenceV1: input.intent.evidence,
        content: input.intent.content, createdAt: input.at,
        ...(input.intent.docEditProposal ? { docEditProposalDispositionV1: { state: 'open' } } : {}),
        ...(input.producer ? { producerV1: input.producer } : {}),
        ...(input.intent.replyTarget ? { replyTargetV1: input.intent.replyTarget } : {}),
        addressingV1: { throughSeq: input.seq, participantSessionIds: [...input.addressedSessionIds ?? []],
            ...(input.watcherSessionIds?.length ? { watcherSessionIds: [...input.watcherSessionIds] } : {}) },
    }, select: { id: true } });
    if (input.intent.mentionedAccountIds.length) await tx.discussionMessageMention.createMany({ data: input.intent.mentionedAccountIds.map(accountId => ({ messageId: message.id, accountId })) });
    return tx.discussionMessage.findUniqueOrThrow({ where: { id: message.id }, select: DISCUSSION_MESSAGE_SELECT });
}

async function publishChangedInTx(tx: Tx, discussionId: string, accessChanged = false): Promise<void> {
    const cursors = await markDiscussionReadersChangedInTx({ tx, discussionId, accessChanged });
    scheduleDiscussionBadgeRefreshInTx({ tx, accountIds: cursors.map(row => row.accountId) });
}

type DiscussionCreationInput = Actor & Readonly<{
    request: DiscussionCreateRequestV1; producer?: DiscussionProducerV1;
    preparedAttachments?: readonly PreparedDiscussionAttachmentWrite[];
}>;

/** One census serves creation's prepared entry and in-transaction recheck. */
async function readDiscussionCreationAdmissionInTx(tx: Tx, input: DiscussionCreationInput) {
    const request = input.request;
    const admissionSessionIds = [input.producer?.kind === 'agent' ? input.producer.sessionId : undefined, input.authentication.sessionRuntimePrincipal?.sessionId,
        ...(request.anchor?.kind === 'session' ? [request.anchor.sessionId] : []),
        ...(request.firstMessage.mentionedSessionIds ?? []),
        ...(request.participants ?? []).flatMap(participant => participant.kind === 'session' ? [participant.sessionId] : []),
    ].filter((id): id is string => typeof id === 'string');
    const admissionAccountIds = [input.actorAccountId,
        ...(request.participants ?? []).flatMap(participant => participant.kind === 'account' ? [participant.accountId] : []),
        ...await readDiscussionDocSourceAuthorityAccountIdsInTx(tx,
            request.firstMessage.replyTarget?.kind === 'doc_passage' ? request.firstMessage.replyTarget.doc : null)];
    const admissionAudience = await readSessionAccountCursorAudienceInTx(tx, admissionSessionIds, admissionAccountIds);
    return { admissionAudience, admissionSessionIds, admissionAccountIds,
        artifactId: request.firstMessage.replyTarget?.kind === 'doc_passage' ? request.firstMessage.replyTarget.doc.ref.artifactId : null };
}

async function fenceDiscussionCreationAdmissionInTx(tx: Tx,
    { admissionAudience, admissionSessionIds, admissionAccountIds, artifactId }: Awaited<ReturnType<typeof readDiscussionCreationAdmissionInTx>>) {
    await fenceSessionAccountCursorAudienceInTx(tx, admissionAudience, admissionSessionIds, admissionAccountIds, {
        intent: artifactId ? resolveArtifactPublicationAdmissionIntent() : 'content',
    });
    if (artifactId) await acquireArtifactPublicationLocksInTx(tx, artifactId, admissionAudience.accountIds, { intent: 'content' });
}

/** Both transports fence the complete cohort before reading publisher or domain authority. */
export async function prepareDiscussionCreationMutationAccounts(input: DiscussionCreationInput): Promise<(tx: Tx) => Promise<void>> {
    if (getDbProviderFromEnv(process.env, 'postgres') === 'sqlite') return async () => {};
    const parsed = DiscussionCreateRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return async () => {};
    const admission = await inReadSnapshot(tx =>
        readDiscussionCreationAdmissionInTx(tx, { ...input, request: parsed.data }));
    return tx => fenceDiscussionCreationAdmissionInTx(tx, admission);
}

/** Creates the resource and first post atomically; retry identity belongs to the creator, not an anchor. */
export async function createDiscussionInTx(tx: Tx, input: DiscussionCreationInput): Promise<DiscussionResult<DiscussionCreateResponseV1>> {
    const parsed = DiscussionCreateRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure('discussion_invalid_content');
    const request = parsed.data;
    await fenceDiscussionCreationAdmissionInTx(tx, await readDiscussionCreationAdmissionInTx(tx, { ...input, request }));
    if (!await isDiscussionCredentialCurrentInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) {
        return discussionFailure('discussion_post_denied');
    }
    const runtime = input.authentication.sessionRuntimePrincipal;
    const rawProducer = input.producer ?? (runtime ? { v: 1 as const, kind: 'agent' as const, sessionId: runtime.sessionId } : undefined);
    let producer: DiscussionProducerV1 | undefined;
    if (rawProducer) {
        const parsedProducer = DiscussionProducerV1Schema.safeParse(rawProducer);
        if (!parsedProducer.success || parsedProducer.data.kind !== 'agent' || parsedProducer.data.replyReturn !== undefined || parsedProducer.data.actionRequestAttributionV1 !== undefined
            || (runtime && runtime.sessionId !== parsedProducer.data.sessionId)) return discussionFailure('discussion_post_denied');
        const session = await tx.session.findUnique({ where: { id: parsedProducer.data.sessionId }, select: { accountId: true, archivedAt: true } });
        if (!session || session.accountId !== input.actorAccountId || session.archivedAt) return discussionFailure('discussion_post_denied');
        producer = parsedProducer.data;
    }
    // Atomic creation has no existing participant roster. The credential's
    // exact runtime was checked above; only this create/rejoin projection uses
    // its owner's Account access. Ordinary reads/posts retain participant admission.
    const { sessionRuntimePrincipal: _runtime, ...creatorAuthentication } = input.authentication;
    const existing = await tx.discussion.findUnique({ where: { createdByAccountId_creationLocalId: {
        createdByAccountId: input.actorAccountId, creationLocalId: request.creationLocalId,
    } }, select: { id: true, createdByAccountId: true, creationEqualityEvidenceV1: true } });
    if (existing) {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: existing.id, accountId: input.actorAccountId, authentication: creatorAuthentication });
        if (!context) return discussionFailure('discussion_not_found');
        const intent = messageIntent(context.storageMode, request.firstMessage);
        const evidence = creationEvidence(context.storageMode, request);
        if ('error' in intent) return discussionFailure(intent.error);
        if ('error' in evidence) return discussionFailure(evidence.error);
        const first = await readMessageByLocalIdInTx(tx, existing.id, intent.localId);
        if (!first || existing.createdByAccountId !== input.actorAccountId || first.authorAccountId !== input.actorAccountId
            || !equalEvidence(existing.creationEqualityEvidenceV1, evidence) || !equalEvidence(first.requestEqualityEvidenceV1, intent.evidence)
            || !equalProducer(first.producerV1, producer)
            || (first.docEditProposalDispositionV1 != null) !== intent.docEditProposal) return discussionFailure('discussion_idempotency_conflict');
        if (!await admitDiscussionAttachmentsInTx(tx, { ownerAccountId: context.ownerAccountId, mode: context.storageMode,
            request: request.firstMessage, plainReferences: intent.plainAttachmentReferences,
            existingMessageId: first.id })) return discussionFailure('discussion_idempotency_conflict');
        const messageAdmissions = new Map<string, AdmittedDiscussionMessageRow>();
        const admitted = admitDiscussionStoredMessage(first, context.storageMode, messageAdmissions);
        if (!admitted.ok) return admitted;
        const sources = await resolveDiscussionDocSourcesInTx(tx, { discussionId: existing.id, admittedMessages: [admitted.value] });
        if (!sources.ok) return sources;
        const source = await admitDiscussionDocSourceInTx(tx, { ...input, authentication: creatorAuthentication, source: sources.value.get(first.id) ?? null,
            destination: { kind: 'resource', resourceId: existing.id, adapter: discussionContextStorageAdapter } });
        if (!source.ok) return source;
        const discussion = await readDiscussionRowInTx(tx, { discussionId: existing.id });
        if (!discussion) return discussionFailure('discussion_not_found');
        const sourceQuote = await admitDiscussionSecondOpinionSourceInTx(tx, { ...input, authentication: creatorAuthentication,
            anchor: discussion.anchorV1, destination: { kind: 'resource', resourceId: existing.id, adapter: discussionContextStorageAdapter } });
        if (!sourceQuote.ok) return sourceQuote;
        const projected = await projectDiscussionForViewerInTx(tx, { context, discussion,
            viewerAccountId: input.actorAccountId, authentication: input.authentication, messageAdmissions });
        if (!projected.ok) return projected;
        const actors = await projectDiscussionAccountActorsInTx(tx, [admitted.value]);
        return discussionSuccess({ discussion: projected.value, firstMessage: projectDiscussionMessageV1(admitted.value, input.actorAccountId,
            actors.messages[0]?.accountActor ?? null, actors.messages[0]?.requesterAccountActor ?? null) });
    }
    const initial = await validateInitialDiscussionGrantsInTx(tx, { actorAccountId: input.actorAccountId, authentication: creatorAuthentication, request });
    if (!initial.ok) return initial;
    const mode = initial.value.storageMode;
    const intent = messageIntent(mode, request.firstMessage);
    const evidence = creationEvidence(mode, request);
    if ('error' in intent) return discussionFailure(intent.error);
    if ('error' in evidence) return discussionFailure(evidence.error);
    if (!await admitDiscussionAttachmentsInTx(tx, { ownerAccountId: input.actorAccountId, mode,
        request: request.firstMessage, plainReferences: intent.plainAttachmentReferences,
        prepared: input.preparedAttachments })) return discussionFailure('discussion_invalid_content');
    if (intent.replyTarget?.kind === 'message') return discussionFailure('discussion_invalid_reply_target');
    const readers = new Set([input.actorAccountId, ...initial.value.participantAccountIds]);
    if (intent.mentionedAccountIds.some(id => !readers.has(id))) return discussionFailure('discussion_invalid_mention');
    const source = intent.replyTarget?.kind === 'doc_passage' ? intent.replyTarget.doc : null;
    if (!validateDiscussionDocContentSource({ content: intent.content, source, root: source !== null })) {
        return discussionFailure('discussion_invalid_reply_target');
    }
    const admission = await admitDiscussionDocSourceInTx(tx, { ...input, source,
        destination: { kind: 'resource', resourceId: request.creationLocalId,
            adapter: newDiscussionContextStorageAdapter({ resourceId: request.creationLocalId, ownerAccountId: input.actorAccountId,
                encryptionMode: mode, participantAccountIds: initial.value.participantAccountIds }) } });
    if (!admission.ok) return admission;
    if (source) {
        // Source-only membership writers need not hold the Artifact parent.
        // Their Account publication orders this fresh disclosure decision;
        // a rejection must roll back the resource, first post and all cursors.
        beforeAccountChangePublication(tx, [...readers], async client => {
            const current = await admitDiscussionDocSourceInTx(client, { ...input, source,
                destination: { kind: 'resource', resourceId: request.creationLocalId,
                    adapter: newDiscussionContextStorageAdapter({ resourceId: request.creationLocalId, ownerAccountId: input.actorAccountId,
                        encryptionMode: mode, participantAccountIds: initial.value.participantAccountIds }) } });
            if (!current.ok) throw new DiscussionCreationRejectedError(current.error);
        });
    }
    const sourceQuote = await admitDiscussionSecondOpinionSourceInTx(tx, { ...input, anchor: request.anchor,
        destination: { kind: 'resource', resourceId: request.creationLocalId,
            adapter: newDiscussionContextStorageAdapter({ resourceId: request.creationLocalId, ownerAccountId: input.actorAccountId,
                encryptionMode: mode, participantAccountIds: initial.value.participantAccountIds }) } });
    if (!sourceQuote.ok) return sourceQuote;
    const now = new Date();
    const row = await tx.discussion.create({ data: {
        ownerAccountId: input.actorAccountId, createdByAccountId: input.actorAccountId, encryptionMode: mode,
        dataEncryptionKey: initial.value.dataEncryptionKey,
        creationLocalId: request.creationLocalId, creationEqualityEvidenceV1: evidence,
        // Initial Follow attachments must start before the first committed
        // occurrence. The resource and seq1 become visible in one transaction.
        titleContent: request.titleContent, messageSeq: 0, lastMessageAt: now,
        openCommentCount: request.anchor?.kind === 'doc' && source?.ref.artifactId === request.anchor.doc.ref.artifactId ? 1 : 0,
        ...(request.anchor ? { anchorV1: request.anchor,
            ...(request.anchor.kind === 'session' ? { anchorSessionId: request.anchor.sessionId } : {}) } : {}),
    }, select: { id: true } });
    await applyInitialDiscussionGrantsInTx(tx, { actorAccountId: input.actorAccountId, discussionId: row.id, initial: initial.value });
    // Bind through the same current control/disclosure/key owner as a later Invite.
    // A typed decline unwinds this entire transaction, including earlier slots.
    for (const participant of request.participants ?? []) {
        if (participant.kind !== 'session') continue;
        const invited = await inviteDiscussionParticipantInTx(tx, { actorAccountId: input.actorAccountId,
            authentication: creatorAuthentication, discussionId: row.id, request: { participant } });
        if (!invited.ok) throw new DiscussionCreationRejectedError(invited.error);
    }
    const addressed = await admitAddressedParticipantsInTx(tx, { ...input, authentication: creatorAuthentication,
        discussionId: row.id, intent, producer });
    if (!addressed.ok) throw new DiscussionCreationRejectedError(addressed.error);
    const first = await insertMessageInTx(tx, { discussionId: row.id, actorAccountId: input.actorAccountId, seq: 1,
        intent, producer, at: now, ...addressed.value });
    await bindDiscussionAttachmentsInTx(tx, first.id, input.preparedAttachments);
    await tx.discussion.update({ where: { id: row.id }, data: { messageSeq: 1 } });
    // Initial attachment already queues C1's after-commit source hint; its
    // receiver observes this committed seq1, never the uncommitted empty head.
    await initializeDiscussionReadBaselinesInTx(tx, { discussionId: row.id, accountIds: [...readers], lastReadSeq: 0 });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: row.id, accountId: input.actorAccountId, authentication: creatorAuthentication });
    const discussion = await readDiscussionRowInTx(tx, { discussionId: row.id });
    // An invariant failure after writes must roll back, never commit an
    // incomplete resource under a returned domain failure.
    if (!context || !discussion) throw new Error('Created Discussion failed its own grant admission');
    const messageAdmissions = new Map<string, AdmittedDiscussionMessageRow>();
    const admitted = admitDiscussionStoredMessage(first, context.storageMode, messageAdmissions);
    if (!admitted.ok) throw new Error(`Created Discussion message projection failed: ${admitted.error}`);
    const projected = await projectDiscussionForViewerInTx(tx, { context, discussion,
        viewerAccountId: input.actorAccountId, authentication: input.authentication, messageAdmissions });
    if (!projected.ok) throw new Error(`Created Discussion projection failed: ${projected.error}`);
    await publishChangedInTx(tx, row.id);
    const actors = await projectDiscussionAccountActorsInTx(tx, [admitted.value]);
    return discussionSuccess({ discussion: projected.value, firstMessage: projectDiscussionMessageV1(admitted.value, input.actorAccountId,
        actors.messages[0]?.accountActor ?? null, actors.messages[0]?.requesterAccountActor ?? null) });
}

export async function createDiscussion(input: Parameters<typeof createDiscussionInTx>[1]): Promise<DiscussionResult<DiscussionCreateResponseV1>> {
    // Admission fences protect current authority; the unique creation identity
    // and reconciliation below adjudicate concurrent inserts. A Serializable
    // snapshot would also conflict with unrelated Account cursor publication.
    return reconcileDiscussionCreationIdentityRace(() => inTx(tx => createDiscussionInTx(tx, input), {
        prepare: () => prepareDiscussionCreationMutationAccounts(input),
    }));
}

/** Ordinary runtime provenance requires membership; a validated Workflow original authorizes its exact execution Session. */
async function admitProducerInTx(tx: Tx, input: ExactDiscussion & Readonly<{
    ownerAccountId: string;
    producer?: DiscussionProducerV1; draftReview?: { artifactId: string; decidingAccountId: string };
    workflowReply?: SessionMessageReplyProgressV1;
    workflowReturn?: Readonly<{ machineId: string; origin: WorkflowDiscussionOriginV1; expectedParentRevision?: number }>;
}>): Promise<DiscussionResult<DiscussionProducerV1 | undefined>> {
    const runtime = input.authentication.sessionRuntimePrincipal;
    const producer = input.producer ?? (runtime ? { v: 1 as const, kind: 'agent' as const, sessionId: runtime.sessionId } : undefined);
    // Account automation keeps Account authorship on its own resource. It does
    // not acquire Session provenance or another Account's publishing authority.
    if (!producer) return input.authentication.authority === 'present_user'
        || input.actorAccountId === input.ownerAccountId && input.authentication.contentDisclosureSessionId === undefined
        ? discussionSuccess(undefined) : discussionFailure('discussion_post_denied');
    const parsed = DiscussionProducerV1Schema.safeParse(producer);
    if (!parsed.success) return discussionFailure('discussion_post_denied');
    if (parsed.data.kind === 'workflow') return input.workflowReturn && !runtime
        ? discussionSuccess(parsed.data) : discussionFailure('discussion_post_denied');
    if (parsed.data.replyReturn !== undefined || parsed.data.actionRequestAttributionV1 !== undefined
        || (runtime && runtime.sessionId !== parsed.data.sessionId)) return discussionFailure('discussion_post_denied');
    if (input.draftReview) {
        // Bind the opaque review to its publishing Account and Session. The
        // installed host validates the private decision and exact input/body;
        // its full-input signature includes the Discussion identity.
        const artifact = await tx.artifact.findUnique({ where: { id: input.draftReview.artifactId },
            select: { accountId: true, kind: true, approvalSessionId: true, deletedAt: true } });
        if (!artifact || artifact.deletedAt || artifact.accountId !== input.actorAccountId
            || decodeArtifactKindV1(artifact.kind).kindHint !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
            || artifact.approvalSessionId !== parsed.data.sessionId) return discussionFailure('discussion_post_denied');
        // Only the trusted publisher transport can assert the private V2
        // review. Its reviewer remains current even when a protected Workflow
        // original admits an implicit leaf without a participant row.
        const reviewer = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
            accountId: input.draftReview.decidingAccountId, authentication: backgroundDeliveryAuthentication() });
        if (!reviewer?.keyReadiness || reviewer.access.level === 'view') return discussionFailure('discussion_post_denied');
    }
    const participant = await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: { discussionId: input.discussionId, sessionId: parsed.data.sessionId } }, select: { answerPolicy: true, removedAt: true, session: { select: { accountId: true } } } });
    if (!participant && input.workflowReply?.workflow
        && input.workflowReply.discussion?.participantSessionId === parsed.data.sessionId) return discussionSuccess(parsed.data);
    if (!participant || participant.removedAt || participant.session?.accountId !== input.actorAccountId) return discussionFailure('discussion_post_denied');
    if (participant.answerPolicy === 'drafts_for_approval' && !input.draftReview?.artifactId) return discussionFailure('discussion_post_denied');
    if (participant.answerPolicy !== 'drafts_for_approval' && participant.answerPolicy !== 'when_addressed'
        && participant.answerPolicy !== 'watches_and_speaks_up') return discussionFailure('discussion_post_denied');
    return discussionSuccess(parsed.data);
}

/** The original message owns concrete addressing; C1 owns current receiver disclosure/admission. */
async function admitAddressedParticipantsInTx(tx: Tx, input: ExactDiscussion & Readonly<{ intent: Intent; producer?: DiscussionProducerV1; informationalReturn?: boolean }>): Promise<DiscussionResult<{ addressedSessionIds: string[]; watcherSessionIds: string[] }>> {
    const ids = new Set(input.intent.mentionedSessionIds);
    let repliedProducer: DiscussionProducerV1 | undefined;
    if (input.intent.replyTarget?.kind === 'message') {
        const replied = await tx.discussionMessage.findFirst({ where: { id: input.intent.replyTarget.messageId, discussionId: input.discussionId }, select: { producerV1: true } });
        if (!replied) return discussionFailure('discussion_invalid_reply_target');
        if (replied.producerV1 != null) {
            const producer = DiscussionProducerV1StoredSchema.safeParse(replied.producerV1);
            if (!producer.success) return discussionFailure('discussion_invalid_content');
            repliedProducer = producer.data;
            if (!input.informationalReturn && producer.data.kind === 'agent'
                && producer.data.sessionId !== (input.producer?.kind === 'agent' ? input.producer.sessionId : undefined)) ids.add(producer.data.sessionId);
        }
    }
    const participants = await tx.discussionParticipant.findMany({ where: { discussionId: input.discussionId, removedAt: null,
        OR: [{ sessionId: { in: [...ids] } }, { answerPolicy: 'watches_and_speaks_up', sessionId: { not: null } }] },
        select: { sessionId: true, answerPolicy: true, session: { select: { archivedAt: true } } } });
    if ([...ids].some(id => !participants.some(participant => participant.sessionId === id))) return discussionFailure('discussion_invalid_mention');
    const addressed: string[] = [];
    const watchers: string[] = [];
    for (const participant of participants) {
        if (participant.answerPolicy === 'reads_only') continue;
        if (participant.answerPolicy === 'watches_and_speaks_up') {
            if (participant.sessionId === (input.producer?.kind === 'agent' ? input.producer.sessionId : undefined)
                || input.informationalReturn && (!ids.has(participant.sessionId ?? '')
                    || participant.sessionId === (repliedProducer?.kind === 'agent' ? repliedProducer.sessionId : undefined))) continue;
        } else if (!ids.has(participant.sessionId ?? '')
            || !['when_addressed', 'drafts_for_approval'].includes(participant.answerPolicy)) continue;
        if (!participant.sessionId || !participant.session || participant.session.archivedAt) {
            if (ids.has(participant.sessionId ?? '')) return discussionFailure('discussion_subject_ineligible');
            continue;
        }
        // Invitation admitted the binding through actual Session control and G.
        // Posting is not a new target-control operation, but must re-admit the
        // current destination audience before committing another disclosure.
        // C1/C2 independently recheck before later observation and dispatch.
        const disclosure = await evaluateCurrentResourceContextPairInTx(tx, {
            source: { kind: 'resource', resourceId: input.discussionId, adapter: discussionContextStorageAdapter },
            destination: { kind: 'session', sessionId: participant.sessionId },
        });
        if (!disclosure.ok) return discussionFailure('discussion_access_forbidden');
        addressed.push(participant.sessionId);
        if (participant.answerPolicy === 'watches_and_speaks_up' && !ids.has(participant.sessionId)) watchers.push(participant.sessionId);
    }
    return discussionSuccess({ addressedSessionIds: addressed.sort(), watcherSessionIds: watchers.sort() });
}

/** The one append writer owns sequence, retry equality, targets, authorship and fanout.
 * Both entry points must consume prepareDiscussionPostMutationAccounts for this
 * exact input on every inTx attempt before invoking this prepared-only writer. */
export async function postPreparedDiscussionMessageInTx(tx: Tx, input: ExactDiscussion & Readonly<{
    request: DiscussionPostRequestV1; producer?: DiscussionProducerV1; replyReturn?: SessionMessageDiscussionReplyReturnV1;
    preparedAttachments?: readonly PreparedDiscussionAttachmentWrite[];
    draftReview?: { artifactId: string; decidingAccountId: string };
    terminalReturn?: true;
    /** Protected installed-Machine custody, never accepted from public authored requests. */
    workflowReturn?: Readonly<{ machineId: string; origin: WorkflowDiscussionOriginV1; expectedParentRevision?: number }>;
}>): Promise<DiscussionResult<DiscussionPostResponseV1>> {
    const parsed = DiscussionPostRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure('discussion_invalid_content');
    const returned = input.replyReturn === undefined ? undefined : SessionMessageDiscussionReplyReturnV1Schema.safeParse(input.replyReturn);
    const runtime = input.authentication.sessionRuntimePrincipal;
    const candidateProducer = input.producer ?? (runtime ? { v: 1 as const, kind: 'agent' as const, sessionId: runtime.sessionId } : undefined);
    if (returned && (!returned.success || !candidateProducer || parsed.data.replyTarget?.kind !== 'message'
        || candidateProducer.kind !== 'agent' || runtime && runtime.sessionId !== candidateProducer.sessionId)) return discussionFailure('discussion_post_denied');
    const returnProgress = returned?.success && candidateProducer?.kind === 'agent' && parsed.data.replyTarget?.kind === 'message'
        ? await readSessionInputDiscussionReplyReturnInTx(tx, { accountId: input.actorAccountId, sessionId: candidateProducer.sessionId,
            ...returned.data, discussionId: input.discussionId, parentMessageId: parsed.data.replyTarget.messageId, localId: parsed.data.localId }) : null;
    if (returned && !returnProgress) return discussionFailure('discussion_post_denied');
    if (candidateProducer?.kind === 'workflow') {
        const custody = input.workflowReturn;
        const identity = candidateProducer;
        const invocation = custody ? await tx.workflowRunInvocation.findFirst({ where: { id: identity.invocationRecordId,
            runId: identity.runId, run: { ...(custody.expectedParentRevision !== undefined
                ? workflowInvocationObservationRunWhere({ accountId: input.actorAccountId, runId: identity.runId,
                    machineId: custody.machineId, expectedRevision: custody.expectedParentRevision })
                : { accountId: input.actorAccountId, claimedByMachineId: custody.machineId }),
                workflowAcceptedSnapshotEnvelope: { not: null } } }, select: { attempt: true, lifecycle: true } }) : null;
        const question = custody ? await tx.discussionMessage.findFirst({ where: { id: custody.origin.messageId,
            discussionId: input.discussionId }, select: { seq: true } }) : null;
        const expectedLifecycle = identity.outcome === 'answer' || identity.outcome === 'pass' || identity.outcome === 'terminal_no_result'
            ? 'completed' : identity.outcome === 'failed' ? 'failed' : identity.outcome === 'cancelled' ? 'cancelled' : null;
        if (!custody) return discussionFailure('discussion_workflow_custody_missing');
        if (returned) return discussionFailure('discussion_workflow_return_conflict');
        if (runtime) return discussionFailure('discussion_workflow_runtime_principal_conflict');
        if (!invocation) return discussionFailure('discussion_workflow_invocation_custody_mismatch');
        if (invocation.attempt.toString() !== identity.invocationAttempt) return discussionFailure('discussion_workflow_attempt_mismatch');
        if (invocation.lifecycle !== expectedLifecycle) return discussionFailure('discussion_workflow_lifecycle_mismatch');
        if (custody.origin.discussion.discussionId !== input.discussionId) return discussionFailure('discussion_workflow_discussion_mismatch');
        if (!question) return discussionFailure('discussion_workflow_question_missing');
        if (question.seq !== custody.origin.throughSeq) return discussionFailure('discussion_workflow_frontier_mismatch');
        if (parsed.data.replyTarget?.kind !== 'message' || parsed.data.replyTarget.messageId !== custody.origin.messageId) {
            return discussionFailure('discussion_workflow_reply_target_mismatch');
        }
        if (parsed.data.localId !== deriveWorkflowDiscussionReplyLocalIdV1(identity)) return discussionFailure('discussion_workflow_local_id_mismatch');
    } else if (input.workflowReturn) return discussionFailure('discussion_workflow_producer_mismatch');
    let authentication = input.authentication;
    if (returnProgress?.workflow && runtime) {
        if (!await isDiscussionCredentialCurrentInTx(tx, {
            accountId: input.actorAccountId, authentication: input.authentication,
        })) return discussionFailure('discussion_post_denied');
        // This exact protected original grants publication, not general runtime
        // membership or access to another Discussion operation.
        const { sessionRuntimePrincipal: _principal, ...accountAuthentication } = authentication;
        authentication = accountAuthentication;
    }
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
        authentication, lockMembershipAuthority: true });
    if (!context) return discussionFailure('discussion_publication_context_unavailable');
    const discussion = await readDiscussionRowInTx(tx, input);
    if (!discussion) return discussionFailure('discussion_not_found');
    const admitted = await admitProducerInTx(tx, { ...input, authentication, ownerAccountId: context.ownerAccountId,
        ...(returnProgress?.workflow ? { workflowReply: returnProgress } : {}) });
    if (!admitted.ok) return admitted;
    let producer = admitted.value;
    const intent = messageIntent(context.storageMode, parsed.data);
    if ('error' in intent) return discussionFailure(intent.error);
    // Decline releases the original return; it is never a public reply outcome.
    const originalOutcome = returnProgress?.outcome;
    if (originalOutcome?.kind === 'declined') return discussionFailure('discussion_post_denied');
    // A committed explicit body answers the original, even when its native
    // final was empty or failed before the person approved publication. Only
    // the verified host final-return path preserves a non-answer outcome.
    const terminalOutcome = input.terminalReturn && originalOutcome && originalOutcome.kind !== 'answer'
        ? { kind: originalOutcome.kind }
        : undefined;
    if (returned?.success && producer?.kind === 'agent' && returnProgress) producer = { ...producer,
        ...(returnProgress.workflow ? { runId: returnProgress.workflow.runId } : {}),
        ...(returnProgress.actionRequestAttributionV1 ? { actionRequestAttributionV1: returnProgress.actionRequestAttributionV1 } : {}),
        ...(returned.data.acceptedTurnId ? { sourceSession: { sourceSessionId: producer.sessionId,
            sourceTurnId: returned.data.acceptedTurnId, sourceInputId: returned.data.requestLocalId, via: 'action' as const } } : {}),
        replyReturn: { ...returned.data, outcome: terminalOutcome?.kind ?? 'answer' },
    };
    const existing = await readMessageByLocalIdInTx(tx, discussion.id, intent.localId);
    const source = await resolveDiscussionDocTargetInTx(tx, { discussionId: discussion.id, replyTarget: intent.replyTarget });
    if (!source.ok) return source;
    if (!validateDiscussionDocContentSource({ content: intent.content, source: source.value, root: intent.replyTarget?.kind === 'doc_passage' })) {
        return discussionFailure('discussion_invalid_reply_target');
    }
    const sourceAdmission = await admitDiscussionDocSourceInTx(tx, { ...input, authentication, source: source.value,
        destination: { kind: 'resource', resourceId: discussion.id, adapter: discussionContextStorageAdapter } });
    if (!sourceAdmission.ok) return sourceAdmission;
    if (existing) {
        if (existing.authorAccountId !== input.actorAccountId || !equalEvidence(existing.requestEqualityEvidenceV1, intent.evidence)
            || !equalProducer(existing.producerV1, producer)
            || (existing.docEditProposalDispositionV1 != null) !== intent.docEditProposal) return discussionFailure('discussion_idempotency_conflict');
        if (!await admitDiscussionAttachmentsInTx(tx, { ownerAccountId: context.ownerAccountId, mode: context.storageMode,
            request: parsed.data, plainReferences: intent.plainAttachmentReferences,
            existingMessageId: existing.id })) return discussionFailure('discussion_idempotency_conflict');
        const admitted = admitDiscussionStoredMessage(existing, context.storageMode);
        if (!admitted.ok) return admitted;
        // An opaque equality tag cannot make caller-supplied metadata the
        // authority for disclosing the already committed message on retry.
        const storedSources = await resolveDiscussionDocSourcesInTx(tx, { discussionId: discussion.id, admittedMessages: [admitted.value] });
        if (!storedSources.ok) return storedSources;
        const storedAdmission = await admitDiscussionDocSourceInTx(tx, { ...input, authentication, source: storedSources.value.get(existing.id) ?? null,
            destination: { kind: 'resource', resourceId: discussion.id, adapter: discussionContextStorageAdapter } });
        if (!storedAdmission.ok) return storedAdmission;
        const actors = await projectDiscussionAccountActorsInTx(tx, [admitted.value]);
        return discussionSuccess({ message: projectDiscussionMessageV1(admitted.value, input.actorAccountId,
            actors.messages[0]?.accountActor ?? null, actors.messages[0]?.requesterAccountActor ?? null), messageSeq: discussion.messageSeq });
    }
    if (!context.keyReadiness) return discussionFailure('discussion_content_unavailable');
    if (context.access.level === 'view') return discussionFailure('discussion_publication_read_only');
    if (discussion.archivedAt) return discussionFailure('discussion_archived');
    if (!await admitDiscussionAttachmentsInTx(tx, { ownerAccountId: context.ownerAccountId, mode: context.storageMode,
        request: parsed.data, plainReferences: intent.plainAttachmentReferences,
        prepared: input.preparedAttachments })) return discussionFailure('discussion_invalid_content');
    const readable = await filterAccountsWithCurrentDiscussionReadAccessInTx(tx, { discussionId: discussion.id, accountIds: intent.mentionedAccountIds });
    if (intent.mentionedAccountIds.some(id => !readable.has(id))) return discussionFailure('discussion_invalid_mention');
    const addressed = await admitAddressedParticipantsInTx(tx, { ...input, authentication, producer, intent,
        informationalReturn: returnProgress !== null || input.workflowReturn !== undefined });
    if (!addressed.ok) return addressed;
    // New addressed questions disclose the source again; ordinary chat and
    // historic reads retain the Discussion's independent lifecycle.
    if (addressed.value.addressedSessionIds.length > 0) {
        const sourceQuote = await admitDiscussionSecondOpinionSourceInTx(tx, { ...input, authentication, anchor: discussion.anchorV1,
            destination: { kind: 'resource', resourceId: discussion.id, adapter: discussionContextStorageAdapter } });
        if (!sourceQuote.ok) return sourceQuote;
    }
    const at = new Date();
    const anchor = DiscussionAnchorV1Schema.safeParse(discussion.anchorV1);
    const newDocRoot = intent.replyTarget?.kind === 'doc_passage' && anchor.success && anchor.data.kind === 'doc'
        && intent.replyTarget.doc.ref.artifactId === anchor.data.doc.ref.artifactId;
    const allocated = await tx.discussion.update({ where: { id: discussion.id }, data: { messageSeq: { increment: 1 }, lastMessageAt: at,
        ...(newDocRoot ? { openCommentCount: { increment: 1 } } : {}) }, select: { messageSeq: true } });
    const message = await insertMessageInTx(tx, { discussionId: discussion.id, actorAccountId: input.actorAccountId, seq: allocated.messageSeq, intent, producer, at, ...addressed.value });
    await bindDiscussionAttachmentsInTx(tx, message.id, input.preparedAttachments);
    // C3 already admitted the destinations whose executable Follow facts changed,
    // including watchers. Other attachments consume no new fact from this post.
    if (addressed.value.addressedSessionIds.length) await invalidateSessionRelationProjectionsInTx(tx, addressed.value.addressedSessionIds);
    if (returned?.success && producer?.kind === 'agent' && !await settleSessionInputDiscussionReplyReturnInTx(tx, {
        accountId: input.actorAccountId, sessionId: producer.sessionId, requestLocalId: returned.data.requestLocalId,
        acceptedTurnId: returned.data.acceptedTurnId, localId: intent.localId,
        workflow: returned.data.workflow,
        publicationRef: { kind: 'discussion', discussion: { serverId: returned.data.serverId, discussionId: discussion.id }, messageId: message.id },
        outcome: terminalOutcome ?? { kind: 'answer', publicationRef: { kind: 'discussion',
            discussion: { serverId: returned.data.serverId, discussionId: discussion.id }, messageId: message.id } },
    })) throw new Error('Discussion publication lost its original reply custody');
    await publishChangedInTx(tx, discussion.id);
    const admittedMessage = admitDiscussionStoredMessage(message, context.storageMode);
    if (!admittedMessage.ok) throw new Error(`Posted Discussion message projection failed: ${admittedMessage.error}`);
    const actors = await projectDiscussionAccountActorsInTx(tx, [admittedMessage.value]);
    return discussionSuccess({ message: projectDiscussionMessageV1(admittedMessage.value, input.actorAccountId,
        actors.messages[0]?.accountActor ?? null, actors.messages[0]?.requesterAccountActor ?? null), messageSeq: allocated.messageSeq });
}

function discussionPostMutationAudience(input: Parameters<typeof postPreparedDiscussionMessageInTx>[1]) {
    return { ...input, includeParticipantSessions: true, append: { replyTarget: input.request.replyTarget },
        additionalSessionIds: [input.producer?.kind === 'agent' ? input.producer.sessionId : undefined, input.authentication.sessionRuntimePrincipal?.sessionId,
            ...(input.request.mentionedSessionIds ?? [])].filter((id): id is string => typeof id === 'string') };
}

/** Public HTTP and trusted publication refresh the same complete cohort per attempt. */
export function prepareDiscussionPostMutationAccounts(input: Parameters<typeof postPreparedDiscussionMessageInTx>[1]) {
    return prepareDiscussionMutationAccounts(discussionPostMutationAudience(input));
}

export async function postDiscussionMessage(input: Parameters<typeof postPreparedDiscussionMessageInTx>[1]): Promise<DiscussionResult<DiscussionPostResponseV1>> {
    return inTx(tx => postPreparedDiscussionMessageInTx(tx, input), { prepare: () => prepareDiscussionPostMutationAccounts(input) });
}

/** Management depends on the Discussion grant; the source Session's lifecycle is irrelevant. */
async function manageDiscussion(input: ExactDiscussion & Readonly<{
    intent: 'rename' | 'archive' | 'restore'; titleContent?: StrictSessionStoredMessageContentEnvelope;
}>): Promise<DiscussionResult<DiscussionDetailsResponseV1>> {
    return inTx(async tx => {
        if (input.intent === 'rename') await acquireDiscussionMutationAccountsInTx(tx, input);
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        if (context.access.level !== 'owner' && context.access.level !== 'admin') return discussionFailure('discussion_manage_denied');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        let changed = false;
        if (input.intent === 'rename') {
            if (discussion.archivedAt) return discussionFailure('discussion_archived');
            if (!input.titleContent) return discussionFailure('discussion_invalid_content');
            if (!context.keyReadiness) return discussionFailure('discussion_content_unavailable');
            const failure = validateDiscussionStoredContent(input.titleContent, context.storageMode, 'title');
            if (failure) return discussionFailure(failure);
            if (input.titleContent.t === 'plain' && !DiscussionTitleV1Schema.safeParse(input.titleContent.v).success) return discussionFailure('discussion_invalid_content');
            changed = !isDeepStrictEqual(discussion.titleContent, input.titleContent);
            if (changed) await tx.discussion.update({ where: { id: discussion.id }, data: { titleContent: input.titleContent } });
        } else {
            const archivedAt = input.intent === 'archive' ? discussion.archivedAt ?? new Date() : null;
            changed = archivedAt !== discussion.archivedAt;
            if (changed) {
                if (archivedAt) {
                    // A concurrent archive may have committed after this read.
                    // Keep its accepted timestamp and run lifecycle effects only
                    // for the transaction that actually changes the state.
                    const archived = await tx.discussion.updateMany({ where: { id: discussion.id, archivedAt: null }, data: { archivedAt } });
                    changed = archived.count === 1;
                    if (changed) {
                        await withdrawDiscussionInputRepliesInTx(tx, { discussionId: discussion.id });
                        await detachDiscussionFollowSourceInTx(tx, { discussionId: discussion.id });
                    }
                } else {
                    await tx.discussion.update({ where: { id: discussion.id }, data: { archivedAt } });
                    const participants = await tx.discussionParticipant.findMany({ where: { discussionId: discussion.id,
                        removedAt: null, sessionId: { not: null } }, select: { sessionId: true } });
                    for (const participant of participants) if (participant.sessionId) await attachDiscussionFollowSourceInTx(tx, {
                        discussionId: discussion.id, destinationSessionId: participant.sessionId,
                    });
                }
            }
        }
        const current = await readDiscussionRowInTx(tx, input);
        if (!current) throw new Error('Managed Discussion disappeared inside its transaction');
        const projected = await projectDiscussionForViewerInTx(tx, { context, discussion: current,
            viewerAccountId: input.actorAccountId, authentication: input.authentication });
        if (!projected.ok) throw new Error(`Managed Discussion projection failed: ${projected.error}`);
        if (changed) await publishChangedInTx(tx, discussion.id, input.intent !== 'rename');
        if (input.intent === 'archive') {
            // Retained owned rows also cover a lost remove response. Lifecycle
            // effects run through ordinary Session Actions after this commit.
            const rows = await tx.discussionParticipant.findMany({ where: { discussionId: discussion.id },
                select: { participantSlotId: true, sessionId: true, modelLaunch: true }, orderBy: { participantSlotId: 'asc' } });
            const ownedSessions = rows.flatMap(row => row.modelLaunch != null && row.sessionId
                ? [{ discussionId: discussion.id, participantSlotId: row.participantSlotId, sessionId: row.sessionId }] : []);
            return discussionSuccess({ discussion: projected.value, ownedSessions });
        }
        return discussionSuccess({ discussion: projected.value });
    }, input.intent === 'rename' ? {} : {
        prepare: () => prepareDiscussionMutationAccounts({ ...input, includeParticipantSessions: true }),
    });
}

export const renameDiscussion = (input: ExactDiscussion & Readonly<{ titleContent: StrictSessionStoredMessageContentEnvelope }>): Promise<DiscussionResult<DiscussionDetailsResponseV1>> => manageDiscussion({ ...input, intent: 'rename' });
export const archiveDiscussion = (input: ExactDiscussion): Promise<DiscussionResult<DiscussionDetailsResponseV1>> => manageDiscussion({ ...input, intent: 'archive' });
export const restoreDiscussion = (input: ExactDiscussion): Promise<DiscussionResult<DiscussionDetailsResponseV1>> => manageDiscussion({ ...input, intent: 'restore' });
