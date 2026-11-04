import type { z } from 'zod/mini';
import type { DiscussionCreateResultV1 } from '@happier-dev/protocol/discussions/actions';
import { DocCollaborationActionOutputSchemasV1, deriveDocCommentDiscussionCreationLocalIdV1,
    type DocCommentReplyInputV1, type DocEditProposeInputV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { bindDiscussionActionHttpRequestV1, discussionActionOutputSchemaV1, hasProtectedDiscussionActionContextV1, readDiscussionCandidatesV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { buildDiscussionAttachmentBindingsV1, buildDiscussionMutationRequestBodyV1, DISCUSSION_HTTP_PATHS_V1, DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema, DiscussionErrorResponseV1Schema, DiscussionListResponseV1Schema, DiscussionMessagesResponseV1Schema, DiscussionPostResponseV1Schema, DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionAccessRecipientCensusResponseV1Schema, DiscussionRecipientKeyEnvelopeCommitResponseV1Schema } from '@happier-dev/protocol/discussions/access';
import { runResourceRecipientKeyPreparationV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import { DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1, DiscussionCreateInputV1Schema, DiscussionCreateResultV1Schema, DiscussionDetailsResultV1Schema, DiscussionListResultV1Schema, DiscussionOpenedMessageV1Schema, DiscussionOpenedSummaryV1Schema, DiscussionPostInputV1Schema, DiscussionPostResultV1Schema, DiscussionReadInputV1Schema, DiscussionReadResultV1Schema, DiscussionReadStateResultV1Schema, DiscussionRenameInputV1Schema, type DiscussionActionInputV1ById } from '@happier-dev/protocol/discussions/actions';
import { DiscussionMessageContentV1Schema, DiscussionMessageContentV1StoredSchema, DiscussionTitleV1Schema, DiscussionTitleV1StoredSchema, readDiscussionMentionedParticipantIdsV1, readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { DiscussionActionIdV1 } from '@happier-dev/protocol/discussions/actionIds';
import type { DiscussionMessageV1, DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { openSessionStoredContent, sealSessionStoredContent } from '@happier-dev/sync-client';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Encryption } from '@/sync/encryption/encryption';
import { createResourceDataKey, openResourceDataKey, type ResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { resourceStoredContentContext } from '@/sync/encryption/resourceStoredContent';
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { prepareDiscussionExecutableParticipantInvitation, type DiscussionExecutableParticipantInviteInput } from './executableParticipantInvitation';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewResponseV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionSecondOpinionStartInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { DiscussionInitialParticipantsV1Schema, type DiscussionInitialParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import { projectDiscussionSecondOpinionPreviewInputV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { DiscussionCandidatesListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionAttentionResponseV1Schema, type DiscussionAttentionQueryV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionAttentionResultV1Schema, type DiscussionAttentionResultV1 } from '@happier-dev/protocol/discussions/actions';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/discussions/actions';
import { DiscussionSettingsResponseV1Schema, type DiscussionSettingsV1 } from '@happier-dev/protocol/discussions/settings';
import { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadResultV1Schema } from '@happier-dev/protocol/discussions/attachments';
import { createBinaryContentEncryption, openBinaryContent } from '@/sync/encryption/binaryContent';
import { encodeBase64 } from '@/encryption/base64';
import type { PreparedAttachmentSource } from '@/sync/domains/attachments/prepareAttachmentPayloads';
import { prepareDiscussionAttachmentUpload, requestDiscussionAttachmentUpload, readDiscussionAttachmentStoredContent } from './discussionAttachmentTransport';
import { requestDiscussionHttp } from './discussionHttp';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isActionAccountScopeChangedError, isActionEffectResult } from '@/sync/domains/scope/actionAccountScopeError';
import { createActionApprovalContinuation, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

type DiscussionAction = NonNullable<ActionExecutorDeps['discussionAction']>;
type DiscussionActionResult<T extends DiscussionActionIdV1> = z.infer<(typeof DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1)[T]>;
const CLIENT_ACTION_OUTPUT_SCHEMAS = { ...DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1,
    'doc.comment.reply': DocCollaborationActionOutputSchemasV1['doc.comment.reply'],
    'doc.edit.propose': DocCollaborationActionOutputSchemasV1['doc.edit.propose'] } as const;
type ClientActionInputs = DiscussionActionInputV1ById & { 'doc.comment.reply': DocCommentReplyInputV1; 'doc.edit.propose': DocEditProposeInputV1 };
type ClientActionResult<T extends keyof ClientActionInputs> = z.infer<(typeof CLIENT_ACTION_OUTPUT_SCHEMAS)[T]>;
type AdapterOptions = Readonly<{
    scope: ServerAccountScope;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    accountMode?: 'plain' | 'e2ee';
    encryption: Pick<Encryption, 'encryptEncryptionKey' | 'decryptEncryptionKey'> | null;
    resolveEncryption?: () => Promise<Pick<Encryption, 'encryptEncryptionKey' | 'decryptEncryptionKey'> | null>;
    ownerContentPublicKeyFingerprint?: string;
    availability: SessionCollaborationAvailability;
    attachmentSources?: readonly PreparedAttachmentSource[];
    assertCurrent?: () => void;
}>;
function failure(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }
function refusal(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }

async function readJson(options: AdapterOptions, actionId: DiscussionActionIdV1, input: unknown, signal?: AbortSignal, bodyOverride?: unknown): Promise<unknown> {
    const bound = bindDiscussionActionHttpRequestV1(actionId, input);
    const body = bodyOverride ?? bound.body;
    return readTransportJson(options, bound.path, bound.method, body, signal);
}
async function readTransportJson(options: AdapterOptions, path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const response = await requestDiscussionHttp(options, path, { method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = DiscussionErrorResponseV1Schema.safeParse(payload);
        throw refusal(parsed.success ? parsed.data.error : response.status === 404 ? 'unsupported_action' : 'outcome_unknown');
    }
    return payload;
}
async function resourceKey(options: AdapterOptions, row: DiscussionSummaryV1): Promise<ResourceDataKey | null> {
    if (!row.keyReadiness) return null;
    try {
        const encryption = row.encryptionMode === 'e2ee' ? await options.resolveEncryption?.() ?? options.encryption : null;
        return await openResourceDataKey({ mode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey,
            ...(encryption ? { decryptDataEncryptionKey: envelope => encryption.decryptEncryptionKey(envelope, options.scope) } : {}) });
    } catch { return null; }
}
async function prepareDiscussionRecipients(options: AdapterOptions, row: DiscussionSummaryV1, signal?: AbortSignal) {
    if (row.encryptionMode === 'plain') return;
    const key = await resourceKey(options, row);
    const path = (template: string) => template.replace(':discussionId', encodeURIComponent(row.id));
    await runResourceRecipientKeyPreparationV1({ dataKey: key?.dataKey ?? null, openedDataEncryptionKey: key?.dataEncryptionKey ?? null,
        randomBytes: getRandomBytes, signal,
        readCensus: async () => DiscussionAccessRecipientCensusResponseV1Schema.parse(await readTransportJson(options,
            path(DISCUSSION_HTTP_PATHS_V1.recipientCensus), 'GET', undefined, signal)),
        validateIdentity: census => { if (census.discussionId !== row.id) throw refusal('discussion_not_found'); },
        dataKeyChangedError: () => refusal('discussion_data_key_changed'),
        commit: async input => DiscussionRecipientKeyEnvelopeCommitResponseV1Schema.parse(await readTransportJson(options,
            path(DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes), 'PUT', input, signal)),
    });
}
async function openSummary(options: AdapterOptions, row: DiscussionSummaryV1, context: Parameters<DiscussionAction>[0]['context']) {
    const key = await resourceKey(options, row);
    const storedContext = resourceStoredContentContext(key);
    const opened = await openSessionStoredContent(storedContext, row.titleContent);
    const title = opened.status === 'ready' ? DiscussionTitleV1StoredSchema.safeParse(opened.value) : null;
    const latestOpened = row.latestMessage.content === undefined || hasProtectedDiscussionActionContextV1(context) ? null
        : await openSessionStoredContent(storedContext, row.latestMessage.content);
    const latestContent = latestOpened?.status === 'ready' ? DiscussionMessageContentV1StoredSchema.safeParse(latestOpened.value) : null;
    const { titleContent: _titleContent, firstMessage, ...projection } = row;
    return DiscussionOpenedSummaryV1Schema.parse({ ...projection, title: title?.success ? title.data.title : null,
        ...(firstMessage === undefined ? {} : { firstMessage: firstMessage === null || key === null
            ? null : await openMessage(options, key, firstMessage) }),
        latestMessage: { ...row.latestMessage, ...(row.latestMessage.content === undefined ? {}
            : { content: latestContent?.success ? latestContent.data : null }) } });
}
async function openMessage(options: AdapterOptions, key: ResourceDataKey | null, row: DiscussionMessageV1) {
    const opened = await openSessionStoredContent(resourceStoredContentContext(key), row.content);
    const content = opened.status === 'ready' ? DiscussionMessageContentV1StoredSchema.safeParse(opened.value) : null;
    return DiscussionOpenedMessageV1Schema.parse({ ...row, content: content?.success ? content.data : null,
        messageRef: createDiscussionMessageRefV1({ serverId: options.scope.serverId, discussionId: row.discussionId }, row) });
}
async function getRawDiscussion(options: AdapterOptions, discussionId: string, signal?: AbortSignal) {
    const value = DiscussionDetailsResponseV1Schema.parse(await readJson(options, 'discussion.get', { discussionId }, signal));
    if (value.discussion.id !== discussionId) throw refusal('discussion_not_found');
    return value.discussion;
}
/** Recover the original envelope before re-sealing an uncertain create under its existing identity. */
async function findCreatedDiscussion(options: AdapterOptions, creationLocalId: string, signal?: AbortSignal) {
    for (const state of ['active', 'archived'] as const) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (;;) {
            const page = DiscussionListResponseV1Schema.parse(await readJson(options, 'discussion.list', { state, creationLocalId, ...(cursor ? { cursor } : {}) }, signal));
            const found = page.discussions.find(row => row.creationLocalId === creationLocalId);
            if (found) return found;
            if (!page.nextCursor) break;
            if (seen.has(page.nextCursor)) throw refusal('outcome_unknown');
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        }
    }
    return null;
}
function equality(key: ResourceDataKey, canonicalIntent: string) {
    return key.mode === 'e2ee' ? { kind: 'e2eeTag' as const,
        tag: deriveDiscussionMutationEqualityTagV1({ dataKey: key.dataKey, canonicalIntent }) } : undefined;
}

/** One host adapter; grants stay server-owned and content uses the Discussion's own key. */
export function createDiscussionActionAdapter(options: AdapterOptions): DiscussionAction {
    return async ({ actionId, input, context, signal }) => {
        if (options.availability === 'unavailable') return failure('unsupported_action');
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, options.scope.serverId)) return failure('discussion_not_found');
        let dispatched = false;
        let preparingRecipients = false;
        try {
            const assertCurrent = () => { signal?.throwIfAborted(); options.assertCurrent?.(); };
            assertCurrent();
            if (actionId === 'discussion.attachment.read') {
                const args = DiscussionAttachmentReadInputV1Schema.parse(input);
                const summary = await getRawDiscussion(options, args.discussionId, signal);
                const key = await resourceKey(options, summary);
                if (!key) return failure('discussion_content_unavailable');
                const page = DiscussionMessagesResponseV1Schema.parse(await readJson(options, 'discussion.read', {
                    discussionId: args.discussionId, messageId: args.messageId, ...(args.throughSeq === undefined ? {} : { throughSeq: args.throughSeq }) }, signal));
                const row = page.messages.find(message => message.id === args.messageId && message.discussionId === args.discussionId);
                if (!row) return failure('discussion_content_unavailable');
                const opened = await openMessage(options, key, row);
                const reference = opened.content === null ? undefined : readDiscussionAttachmentReferencesV1(opened.content).find(file => file.blobId === args.blobId);
                if (!reference) return failure('discussion_content_unavailable');
                const stored = await readDiscussionAttachmentStoredContent({ ...args, request: options.request, assertCurrent }, signal);
                const bytes = await openBinaryContent({ reference, content: stored.content, mode: key.mode,
                    encryption: key.mode === 'e2ee' ? createBinaryContentEncryption(key.dataKey) : null });
                assertCurrent();
                return DiscussionAttachmentReadResultV1Schema.parse({ ...reference, bytesBase64: encodeBase64(bytes) });
            }
            if (actionId === 'discussion.candidates.list') {
                return await readDiscussionCandidatesV1({ scope: options.scope,
                    args: DiscussionCandidatesListInputV1Schema.parse(input), signal,
                    isSameHome: serverId => areServerProfileIdentifiersEquivalent(serverId, options.scope.serverId),
                    request: async request => {
                        dispatched = true;
                        return await readTransportJson(options, request.path, request.method, request.body, signal);
                    } });
            }
            if (actionId === 'discussion.second_opinion.start') {
                const args = DiscussionSecondOpinionStartInputV1Schema.parse(input);
                if (args.intent !== 'preview') return failure('unsupported_action');
                dispatched = true;
                return DiscussionSecondOpinionPreviewResponseV1Schema.parse(await readTransportJson(options,
                    DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, 'POST',
                    projectDiscussionSecondOpinionPreviewInputV1(args), signal));
            }
            let body: unknown;
            let byteUpload: ReturnType<typeof prepareDiscussionAttachmentUpload> | undefined;
            if (actionId === 'discussion.create') {
                if (!options.accountMode) return failure('discussion_encryption_mode_mismatch');
                const args = DiscussionCreateInputV1Schema.parse(input);
                // Selector intent is front-door-only; the storage writer/equality owner sees concrete refs.
                const participants = args.participants === undefined ? undefined : DiscussionInitialParticipantsV1Schema.parse(args.participants);
                const creationLocalId = args.creationLocalId ?? randomUUID();
                const messageLocalId = args.firstMessage.localId ?? randomUUID();
                const retained = options.accountMode === 'e2ee' ? await findCreatedDiscussion(options, creationLocalId, signal) : null;
                const key = retained ? await resourceKey(options, retained) : await createResourceDataKey({ mode: options.accountMode,
                    ...(options.encryption ? { encryptDataEncryptionKey: value => options.encryption!.encryptEncryptionKey(value) } : {}) });
                if (!key || (key.mode === 'e2ee' && !options.ownerContentPublicKeyFingerprint)) return failure('discussion_encryption_mode_mismatch');
                const title = DiscussionTitleV1Schema.parse({ v: 1, title: args.title });
                const content = DiscussionMessageContentV1Schema.parse(args.firstMessage.content);
                const bindings = buildDiscussionAttachmentBindingsV1(content, key.mode === 'plain' ? 'plain' : 'encrypted');
                const attention = readDiscussionMentionedParticipantIdsV1(content);
                const mentionedAccountIds = args.firstMessage.mentionedAccountIds ?? attention.mentionedAccountIds;
                const mentionedSessionIds = args.firstMessage.mentionedSessionIds ?? attention.mentionedSessionIds;
                const titleContent = await sealSessionStoredContent(resourceStoredContentContext(key), StrictJsonValueSchema.parse(title));
                const messageContent = await sealSessionStoredContent(resourceStoredContentContext(key), StrictJsonValueSchema.parse(content));
                if (titleContent.status !== 'ready' || messageContent.status !== 'ready') return failure('discussion_encryption_mode_mismatch');
                body = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId, titleContent: titleContent.content,
                    creationEqualityEvidenceV1: equality(key, serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title,
                        anchor: args.anchor, participants,
                        firstMessage: { localId: messageLocalId, content, ...bindings, mentionedAccountIds, mentionedSessionIds, replyTarget: args.firstMessage.replyTarget } })),
                    anchor: args.anchor, participants,
                    ...(key.mode === 'e2ee' ? { dataEncryptionKey: key.dataEncryptionKey,
                        expectedOwnerContentPublicKeyFingerprint: options.ownerContentPublicKeyFingerprint } : {}),
                    firstMessage: { localId: messageLocalId, content: messageContent.content, authoredContent: content, mentionedAccountIds, mentionedSessionIds,
                        replyTarget: args.firstMessage.replyTarget,
                        requestEqualityEvidenceV1: equality(key, serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, ...bindings, mentionedAccountIds, mentionedSessionIds, replyTarget: args.firstMessage.replyTarget })) } });
                const references = readDiscussionAttachmentReferencesV1(content);
                if (references.length > 0) byteUpload = prepareDiscussionAttachmentUpload({ operation: 'create', body, references,
                    sources: options.attachmentSources ?? [], mode: key.mode,
                    encryption: key.mode === 'e2ee' ? createBinaryContentEncryption(key.dataKey) : null, assertCurrent });
            } else if (actionId === 'discussion.post' || actionId === 'discussion.reply') {
                const args = DiscussionPostInputV1Schema.parse(input);
                const key = await resourceKey(options, await getRawDiscussion(options, args.discussionId, signal));
                if (!key) return failure('discussion_encryption_mode_mismatch');
                const content = DiscussionMessageContentV1Schema.parse(args.content);
                const bindings = buildDiscussionAttachmentBindingsV1(content, key.mode === 'plain' ? 'plain' : 'encrypted');
                const sealed = await sealSessionStoredContent(resourceStoredContentContext(key), StrictJsonValueSchema.parse(content));
                if (sealed.status !== 'ready') return failure('discussion_encryption_mode_mismatch');
                const attention = readDiscussionMentionedParticipantIdsV1(content);
                const mentionedAccountIds = args.mentionedAccountIds ?? attention.mentionedAccountIds;
                const mentionedSessionIds = args.mentionedSessionIds ?? attention.mentionedSessionIds;
                body = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: args.localId ?? randomUUID(), content: sealed.content,
                    authoredContent: content,
                    mentionedAccountIds, mentionedSessionIds, replyTarget: args.replyTarget,
                    requestEqualityEvidenceV1: equality(key, serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, ...bindings, mentionedAccountIds, mentionedSessionIds, replyTarget: args.replyTarget })) });
                const references = readDiscussionAttachmentReferencesV1(content);
                if (references.length > 0) byteUpload = prepareDiscussionAttachmentUpload({ operation: actionId === 'discussion.reply' ? 'reply' : 'post',
                    body, discussionId: args.discussionId, references, sources: options.attachmentSources ?? [], mode: key.mode,
                    encryption: key.mode === 'e2ee' ? createBinaryContentEncryption(key.dataKey) : null, assertCurrent });
            } else if (actionId === 'discussion.rename') {
                const args = DiscussionRenameInputV1Schema.parse(input);
                const key = await resourceKey(options, await getRawDiscussion(options, args.discussionId, signal));
                const sealed = await sealSessionStoredContent(resourceStoredContentContext(key), StrictJsonValueSchema.parse({ v: 1, title: args.title }));
                if (sealed.status !== 'ready') return failure('discussion_encryption_mode_mismatch');
                body = buildDiscussionMutationRequestBodyV1({ kind: 'rename', titleContent: sealed.content });
            }
            const dispatchOptions: AdapterOptions = { ...options, request: (path, init) => {
                dispatched = true;
                return options.request(path, init);
            } };
            const payload = byteUpload ? await requestDiscussionAttachmentUpload(dispatchOptions, byteUpload.metadata, byteUpload.segments, signal)
                : await readJson(dispatchOptions, actionId, input, signal, body);
            assertCurrent();
            const envelope = { v: 1 as const, serverId: options.scope.serverId };
            if (actionId === 'discussion.settings.get' || actionId === 'discussion.settings.set') {
                const args = DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
                const value = DiscussionSettingsResponseV1Schema.parse(payload);
                if (value.discussionId !== args.discussionId) throw refusal('discussion_not_found');
                return value;
            }
            if (actionId === 'discussion.list') {
                const value = DiscussionListResponseV1Schema.parse(payload);
                const discussions = await Promise.all(value.discussions.map(row => openSummary(options, row, context)));
                return DiscussionListResultV1Schema.parse({ ...envelope, discussions, nextCursor: value.nextCursor,
                    incomplete: discussions.some(row => row.title === null || row.latestMessage.content === null) });
            }
            if (actionId === 'discussion.get' || actionId === 'discussion.rename' || actionId === 'discussion.archive' || actionId === 'discussion.restore') {
                const value = DiscussionDetailsResponseV1Schema.parse(payload);
                return DiscussionDetailsResultV1Schema.parse({ ...envelope, discussion: await openSummary(options, value.discussion, context),
                    ...('ownedSessions' in value ? { ownedSessions: value.ownedSessions } : {}) });
            }
            if (actionId === 'discussion.read') {
                const args = DiscussionReadInputV1Schema.parse(input);
                const value = DiscussionMessagesResponseV1Schema.parse(payload);
                if (value.messages.some(row => row.discussionId !== args.discussionId)) throw refusal('outcome_unknown');
                const key = await resourceKey(options, await getRawDiscussion(options, args.discussionId, signal));
                const messages = await Promise.all(value.messages.map(row => openMessage(options, key, row)));
                return DiscussionReadResultV1Schema.parse({ ...envelope, discussionId: args.discussionId, messages,
                    hasMoreOlder: value.hasMoreOlder, messageSeq: value.messageSeq, incomplete: messages.some(row => row.content === null) });
            }
            if (actionId === 'discussion.create') {
                const value = DiscussionCreateResponseV1Schema.parse(payload);
                if (value.firstMessage.discussionId !== value.discussion.id) throw refusal('outcome_unknown');
                if (DiscussionCreateInputV1Schema.parse(input).participants?.some(participant => participant.kind === 'account')) {
                    preparingRecipients = true;
                    await prepareDiscussionRecipients(options, value.discussion, signal);
                    preparingRecipients = false;
                }
                const key = await resourceKey(options, value.discussion);
                return DiscussionCreateResultV1Schema.parse({ ...envelope, discussion: await openSummary(options, value.discussion, context), firstMessage: await openMessage(options, key, value.firstMessage) });
            }
            if (actionId === 'discussion.post' || actionId === 'discussion.reply') {
                const args = DiscussionPostInputV1Schema.parse(input);
                const value = DiscussionPostResponseV1Schema.parse(payload);
                if (value.message.discussionId !== args.discussionId) throw refusal('outcome_unknown');
                const key = await resourceKey(options, await getRawDiscussion(options, args.discussionId, signal));
                return DiscussionPostResultV1Schema.parse({ ...envelope, message: await openMessage(options, key, value.message), messageSeq: value.messageSeq });
            }
            if (actionId === 'discussion.read_state.set') return DiscussionReadStateResultV1Schema.parse({ ...envelope, cursor: DiscussionReadResponseV1Schema.parse(payload) });
            if (actionId === 'discussion.invite' || actionId === 'discussion.access.grants.set') {
                const result = DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(payload);
                if (result.access !== null) {
                    preparingRecipients = true;
                    await prepareDiscussionRecipients(options, await getRawDiscussion(options, result.discussionId, signal), signal);
                    preparingRecipients = false;
                }
                return result;
            }
            return discussionActionOutputSchemaV1(actionId).parse(payload);
        } catch (error) {
            const retiredEffect = dispatched && isActionEffectResult(getActionSpec(actionId).sideEffectClass) && isActionAccountScopeChangedError(error);
            const code = preparingRecipients || retiredEffect ? 'outcome_unknown' : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
                : dispatched ? 'outcome_unknown' : signal?.aborted ? 'canceled' : 'discussion_invalid_content';
            return failure(code);
        }
    };
}

export async function executeDiscussionActionInAccountContext(account: LazyActionAccountContext, availability: SessionCollaborationAvailability,
    args: Parameters<DiscussionAction>[0], attachmentSources?: readonly PreparedAttachmentSource[]) {
    account.assertCurrent();
    const scope = { serverId: account.serverId, accountId: account.accountId };
    const request = (path: string, init?: RequestInit) => account.request(path, init, { retry: 'none' });
    if (args.actionId !== 'discussion.create') {
        return createDiscussionActionAdapter({ scope, request, encryption: null, availability, attachmentSources, assertCurrent: () => account.assertCurrent(),
            resolveEncryption: async () => {
                account.assertCurrent();
                const { encryption } = await account.resolveAccountEncryption();
                account.assertCurrent();
                return encryption;
            } })(args);
    }
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    let ownerContentPublicKeyFingerprint: string | undefined;
    if (accountMode === 'e2ee') {
        const { createAccountScopedCryptoMaterialSnapshotV1 } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
        const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
        const { decodeBase64 } = await import('@/encryption/base64');
        const { isDataKeyAuthCredentials } = await import('@/auth/storage/tokenStorage');
        ownerContentPublicKeyFingerprint = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials),
            ...(isDataKeyAuthCredentials(account.credentials) ? { dataKeyPublicKey: decodeBase64(account.credentials.encryption.publicKey, 'base64') } : {}) }).contentPublicKeyFingerprint;
    }
    account.assertCurrent();
    return createDiscussionActionAdapter({ scope, accountMode, encryption, ownerContentPublicKeyFingerprint, availability, request,
        attachmentSources, assertCurrent: () => account.assertCurrent() })(args);
}

export type DiscussionClientOutcome<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'approval_request_created'; artifactId: string; actionId: string }>
    | Readonly<{ kind: 'failed'; errorCode: string }>;

export type DiscussionExecutableParticipantInviteOutcome = Exclude<DiscussionClientOutcome<DiscussionActionResult<'discussion.invite'>>, Readonly<{ kind: 'failed' }>>
    | Readonly<{ kind: 'failed'; errorCode: string; value?: DiscussionActionResult<'discussion.invite'> }>
    | Readonly<{ kind: 'checking'; value?: DiscussionActionResult<'discussion.invite'> }>;

/** Batch codec for owner-native attention; keys and messages come in the same admitted response. */
export async function readDiscussionAttentionPage(options: AdapterOptions, input: DiscussionAttentionQueryV1 = {}, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionAttentionResultV1>> {
    if (options.availability === 'unavailable') return { kind: 'failed', errorCode: 'unsupported_action' };
    try {
        const query = new URLSearchParams();
        if (input.cursor) query.set('cursor', input.cursor);
        if (input.limit !== undefined) query.set('limit', String(input.limit));
        const suffix = query.size ? `?${query}` : '';
        const page = DiscussionAttentionResponseV1Schema.parse(await readTransportJson(options,
            `${DISCUSSION_HTTP_PATHS_V1.attention}${suffix}`, 'GET', undefined, signal));
        const discussions = await Promise.all(page.discussions.map(async entry => {
            if (entry.occurrences.some(occurrence => occurrence.message.discussionId !== entry.discussion.id)) throw refusal('discussion_invalid_content');
            const key = await resourceKey(options, entry.discussion);
            return { discussion: await openSummary(options, entry.discussion, { surface: 'ui', serverId: options.scope.serverId }),
                occurrences: await Promise.all(entry.occurrences.map(async occurrence => ({ type: occurrence.type,
                    message: await openMessage(options, key, occurrence.message) }))) };
        }));
        signal?.throwIfAborted();
        return { kind: 'succeeded', value: DiscussionAttentionResultV1Schema.parse({ v: 1, serverId: options.scope.serverId,
            discussions, nextCursor: page.nextCursor, incomplete: page.incomplete || discussions.some(entry => entry.discussion.title === null
                || entry.occurrences.some(occurrence => occurrence.message.content === null)) }) };
    } catch (error) {
        return { kind: 'failed', errorCode: signal?.aborted ? 'canceled'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'outcome_unknown' };
    }
}

type DiscussionApprovalCallbacks<T> = Readonly<{
    onPending: (continuation: ActionApprovalContinuation) => void;
    onSettled: (outcome: DiscussionClientOutcome<T>) => void;
}>;

export function createDiscussionClient(options: Readonly<{ scope: ServerAccountScope; availability: SessionCollaborationAvailability }>) {
    const run = async <T extends keyof ClientActionInputs>(actionId: T, input: ClientActionInputs[T], signal?: AbortSignal,
        onSessionTargetsResolved?: ActionExecutorContext['onSessionTargetsResolved'], attachmentSources?: readonly PreparedAttachmentSource[],
        continuation?: DiscussionApprovalCallbacks<ClientActionResult<T>>): Promise<DiscussionClientOutcome<ClientActionResult<T>>> => {
        if (options.availability === 'unavailable') return { kind: 'failed', errorCode: 'unsupported_action' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor(attachmentSources ? { discussionAttachmentSources: attachmentSources } : undefined).execute(actionId, input, { surface: 'ui', serverId: options.scope.serverId,
            expectedAccountId: options.scope.accountId,
            ...(onSessionTargetsResolved ? { onSessionTargetsResolved } : {}),
            ...(signal ? { signal } : {}) });
        if (!result.ok) return { kind: 'failed', errorCode: result.errorCode };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success) {
            continuation?.onPending(createActionApprovalContinuation<ClientActionResult<T>, T>({
                artifactId: approval.data.artifactId, actionId, scope: options.scope, expectedInput: input,
                ...(signal ? { signal } : {}), refreshAfterExecution: false,
                onSucceeded: value => continuation.onSettled({ kind: 'succeeded', value }),
                onFailed: errorCode => continuation.onSettled({ kind: 'failed', errorCode }),
            }));
            return { kind: 'approval_request_created', artifactId: approval.data.artifactId, actionId: approval.data.actionId };
        }
        const parsed = CLIENT_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(result.result);
        return parsed.success ? { kind: 'succeeded', value: parsed.data as ClientActionResult<T> } : { kind: 'failed', errorCode: 'outcome_unknown' };
    };
    const invite = async (input: DiscussionActionInputV1ById['discussion.invite'], signal?: AbortSignal): Promise<DiscussionExecutableParticipantInviteOutcome> => {
        const outcome = await run('discussion.invite', input, signal);
        if (input.participant.kind !== 'model') return outcome;
        if (outcome.kind === 'failed' && outcome.errorCode === 'outcome_unknown') return { kind: 'checking' };
        if (outcome.kind !== 'succeeded') return outcome;
        const start = outcome.value.sessionStart;
        if (start?.type === 'error') return { kind: 'failed', errorCode: start.code, value: outcome.value };
        if (start?.type !== 'success' || outcome.value.modelParticipant?.sessionId !== start.sessionId) {
            return { kind: 'checking', value: outcome.value };
        }
        return outcome;
    };
    return {
        async attention(input: DiscussionAttentionQueryV1 = {}, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionAttentionResultV1>> {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
            try {
                account = await captureLazyActionAccountContext(options.scope.serverId, signal);
                if (account.accountId !== options.scope.accountId) return { kind: 'failed', errorCode: 'discussion_read_denied' };
                const captured = account;
                const result = await readDiscussionAttentionPage({ ...options, encryption: null,
                    request: (path, init) => captured.request(path, init, { retry: 'none' }),
                    resolveEncryption: async () => { captured.assertCurrent(); const value = await captured.resolveAccountEncryption();
                        captured.assertCurrent(); return value.encryption; } }, input, signal);
                captured.assertCurrent();
                return result;
            } catch { return { kind: 'failed', errorCode: signal?.aborted ? 'canceled' : 'discussion_read_denied' }; }
            finally { account?.dispose(); }
        },
        secondOpinion: (input: DiscussionActionInputV1ById['discussion.second_opinion.start'], signal?: AbortSignal,
            continuation?: DiscussionApprovalCallbacks<ClientActionResult<'discussion.second_opinion.start'>>) =>
            run('discussion.second_opinion.start', input, signal, undefined, undefined, continuation),
        list: (input: DiscussionActionInputV1ById['discussion.list'] = {}, signal?: AbortSignal) => run('discussion.list', input, signal),
        listCandidates: (input: DiscussionActionInputV1ById['discussion.candidates.list'], signal?: AbortSignal) => run('discussion.candidates.list', input, signal),
        get: (discussionId: string, signal?: AbortSignal) => run('discussion.get', { discussionId }, signal),
        getSettings: (discussionId: string, signal?: AbortSignal) => run('discussion.settings.get', { discussionId }, signal),
        setSettings: (discussionId: string, settings: DiscussionSettingsV1, signal?: AbortSignal) => run('discussion.settings.set', { discussionId, settings }, signal),
        read: (discussionId: string, input: Omit<DiscussionActionInputV1ById['discussion.read'], 'discussionId'> = {}, signal?: AbortSignal) => run('discussion.read', { discussionId, ...input }, signal),
        readAttachment: (input: DiscussionActionInputV1ById['discussion.attachment.read'], signal?: AbortSignal) => run('discussion.attachment.read', input, signal),
        create: async (input: Omit<DiscussionActionInputV1ById['discussion.create'], 'firstMessage' | 'participants' | 'attachmentSources'> & {
            messageLocalId: string; content: DiscussionActionInputV1ById['discussion.post']['content']; mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[];
            participants?: readonly NonNullable<DiscussionActionInputV1ById['discussion.create']['participants']>[number][];
            attachmentSources?: readonly PreparedAttachmentSource[];
            onResolvedParticipants?: (participants: readonly DiscussionInitialParticipantV1[]) => void;
            replyTarget?: DiscussionActionInputV1ById['discussion.post']['replyTarget'] }, signal?: AbortSignal,
            continuation?: DiscussionApprovalCallbacks<DiscussionCreateResultV1>): Promise<DiscussionClientOutcome<DiscussionCreateResultV1>> => {
            if ('kind' in input.content && input.content.kind === 'doc_passage_comment') {
                // The Doc comment owner declares no initial-audience operand.
                // Never acknowledge invitations that delegation would discard.
                if (input.participants?.length) return { kind: 'failed', errorCode: 'invalid_parameters' };
                const { passage, content } = input.content;
                const ref = { ...passage.ref, serverId: passage.ref.serverId ?? options.scope.serverId };
                if (ref.serverId !== options.scope.serverId) return { kind: 'failed', errorCode: 'server_target_mismatch' };
                if (input.creationLocalId !== deriveDocCommentDiscussionCreationLocalIdV1({ ref, localId: input.messageLocalId })) {
                    return { kind: 'failed', errorCode: 'discussion_idempotency_conflict' };
                }
                const posted = await run('doc.comment.reply', { target: passage, localId: input.messageLocalId, content }, signal, undefined, input.attachmentSources);
                if (posted.kind !== 'succeeded') return posted;
                const details = await run('discussion.get', { discussionId: posted.value.message.discussionId }, signal);
                if (details.kind !== 'succeeded') return { kind: 'failed', errorCode: 'outcome_unknown' };
                return { kind: 'succeeded', value: DiscussionCreateResultV1Schema.parse({ v: 1, serverId: options.scope.serverId,
                    discussion: details.value.discussion, firstMessage: posted.value.message }) };
            }
            return run('discussion.create', {
            creationLocalId: input.creationLocalId, title: input.title, anchor: input.anchor,
            participants: input.participants === undefined ? undefined : [...input.participants],
            firstMessage: { localId: input.messageLocalId, content: input.content,
                mentionedAccountIds: input.mentionedAccountIds === undefined ? undefined : [...input.mentionedAccountIds],
                mentionedSessionIds: input.mentionedSessionIds === undefined ? undefined : [...input.mentionedSessionIds], replyTarget: input.replyTarget } }, signal,
            resolution => {
                if (resolution.actionId !== 'discussion.create') return;
                const resolved = DiscussionCreateInputV1Schema.parse(resolution.input);
                input.onResolvedParticipants?.(DiscussionInitialParticipantsV1Schema.parse(resolved.participants ?? []));
            }, input.attachmentSources, continuation);
        },
        post: (input: Omit<DiscussionActionInputV1ById['discussion.post'], 'mentionedAccountIds' | 'mentionedSessionIds' | 'attachmentSources'> & { mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[];
            attachmentSources?: readonly PreparedAttachmentSource[] }, signal?: AbortSignal) => {
            if ('kind' in input.content && input.content.kind === 'doc_passage_comment') {
                if (!input.localId) return Promise.resolve({ kind: 'failed' as const, errorCode: 'discussion_invalid_content' });
                return run('doc.comment.reply', { target: input.content.passage, content: input.content.content, localId: input.localId,
                    discussionRef: { serverId: options.scope.serverId, discussionId: input.discussionId },
                    ...(input.replyTarget?.kind === 'message' ? { parentMessageRef: { kind: 'discussion' as const,
                        discussion: { serverId: options.scope.serverId, discussionId: input.discussionId }, messageId: input.replyTarget.messageId } } : {}) }, signal, undefined, input.attachmentSources);
            }
            if ('kind' in input.content && input.content.kind === 'doc_edit_proposal') {
                if (!input.localId) return Promise.resolve({ kind: 'failed' as const, errorCode: 'discussion_invalid_content' });
                return run('doc.edit.propose', { ...input.content.proposal, localId: input.localId,
                    discussionRef: { serverId: options.scope.serverId, discussionId: input.discussionId },
                    ...(input.replyTarget?.kind === 'message' ? { replyTo: { kind: 'discussion' as const,
                        discussion: { serverId: options.scope.serverId, discussionId: input.discussionId }, messageId: input.replyTarget.messageId } } : {}) }, signal);
            }
            return run('discussion.post', {
            discussionId: input.discussionId, localId: input.localId, content: input.content,
            mentionedAccountIds: input.mentionedAccountIds === undefined ? undefined : [...input.mentionedAccountIds],
            mentionedSessionIds: input.mentionedSessionIds === undefined ? undefined : [...input.mentionedSessionIds], replyTarget: input.replyTarget,
        }, signal, undefined, input.attachmentSources);
        },
        reply: (input: Omit<DiscussionActionInputV1ById['discussion.reply'], 'attachmentSources'> & { attachmentSources?: readonly PreparedAttachmentSource[] }, signal?: AbortSignal) => {
            const { attachmentSources, ...authored } = input;
            return run('discussion.reply', authored, signal, undefined, attachmentSources);
        },
        rename: (discussionId: string, title: string, signal?: AbortSignal) => run('discussion.rename', { discussionId, title }, signal),
        archive: (discussionId: string, signal?: AbortSignal) => run('discussion.archive', { discussionId }, signal),
        restore: (discussionId: string, signal?: AbortSignal) => run('discussion.restore', { discussionId }, signal),
        readState: (discussionId: string, lastReadSeq: number, signal?: AbortSignal) => run('discussion.read_state.set', { discussionId, lastReadSeq }, signal),
        participants: (discussionId: string, signal?: AbortSignal) => run('discussion.participants.list', { discussionId }, signal),
        setParticipantPolicy: (input: DiscussionActionInputV1ById['discussion.participant.policy.set'], signal?: AbortSignal) => run('discussion.participant.policy.set', input, signal),
        invite,
        async inviteExecutableParticipant(input: DiscussionExecutableParticipantInviteInput, signal?: AbortSignal): Promise<DiscussionExecutableParticipantInviteOutcome> {
            const prepared = prepareDiscussionExecutableParticipantInvitation(options.scope.serverId, input);
            if (prepared.kind === 'failed') return prepared;
            return invite(prepared.input, signal);
        },
        removeParticipant: (input: DiscussionActionInputV1ById['discussion.participant.remove'], signal?: AbortSignal) => run('discussion.participant.remove', input, signal),
        leave: (discussionId: string, signal?: AbortSignal) => run('discussion.leave', { discussionId }, signal),
        transferOwner: (input: DiscussionActionInputV1ById['discussion.owner.transfer'], signal?: AbortSignal) => run('discussion.owner.transfer', input, signal),
        listGrants: (discussionId: string, signal?: AbortSignal) => run('discussion.access.grants.list', { discussionId }, signal),
        setGrant: (input: DiscussionActionInputV1ById['discussion.access.grants.set'], signal?: AbortSignal) => run('discussion.access.grants.set', input, signal),
        removeGrant: (input: DiscussionActionInputV1ById['discussion.access.grants.remove'], signal?: AbortSignal) => run('discussion.access.grants.remove', input, signal),
    };
}
