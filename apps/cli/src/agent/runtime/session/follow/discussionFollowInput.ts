import { countDocPassageThreadsV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { readDiscussionInputMessages, readDiscussionInputQuestion } from '@/discussions/readDiscussionInputMessages';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionInputRequestV1Schema, assertSessionInputAdmissionReceiptForAuthorityV1,
  buildTrustedHostSessionInputAdmissionV1, readSessionInputAuthority, readSessionInputCausalPermissionAuthorityV1,
  readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveDiscussionFollowInputLocalIdV1, type SessionFollowDiscussionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { hasDirectDiscussionAnswerObligation, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { renderSessionInputContextPromptV1, type DiscussionPromptAuthorV1,
  type DiscussionPromptContextEntryV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { readDiscussionMessagePartsV1, type DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { resolveAccountDisplayLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { deriveSessionInputActionRequestAttributionV1, materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { buildCausalSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { stampTurnFacts } from '../turn/stampTurnFacts';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveSessionInputTargetMachineId } from '@/session/services/sessionInputAdmissionIdentity';
import { readSessionPresentationContent, sealSessionStoredContent, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { formatSessionInputMentionMarkerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';

function readDiscussionPromptText(content: DiscussionMessageContentV1): string {
  return readDiscussionMessagePartsV1(content, 'preview').map(part => part.t === 'text' ? part.text
    : part.t === 'reference' ? formatSessionInputMentionMarkerV1(part.reference)
    : part.t === 'attachment' ? `[${part.attachment.kind === 'folder' ? 'Folder' : 'File'}: ${part.attachment.name}]`
    : part.participant.kind === 'account' ? `@account:${part.participant.accountId}` : `@session:${part.participant.sessionId}`).join('');
}

/** The existing Follow observation becomes one original input through the incumbent Pending owner. */
export function createDiscussionFollowInputIntake(input: Readonly<{
  session: Pick<ApiSessionClient, 'sessionId' | 'getServerBinding' | 'getServerFeaturesSnapshot'
    | 'getMachineAdmissionTransport' | 'runSessionFollowSourceRequest'>;
  credentials: StoredCredentials;
  /** Existing local daemon launch boundary, after accepted original Pending custody. */
  spawnSession?: Parameters<typeof sendSessionMessage>[0]['spawnSession'];
}>) {
  const binding = input.session.getServerBinding();
  const discussionAction = createDiscussionActionDeps({ credentials: input.credentials, serverId: binding.serverId,
    serverHttpBaseUrl: binding.serverUrl, resolveServerFeaturesSnapshot: () => input.session.getServerFeaturesSnapshot() }).discussionAction!;
  const artifacts = createCredentialedAccountArtifactStore(input.credentials);
  return async ({ observation, signal }: Readonly<{ observation: SessionFollowDiscussionPendingObservationV1; signal: AbortSignal }>): Promise<boolean> => {
    if (signal.aborted || observation.destinationSessionId !== input.session.sessionId) return false;
    const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot(input.session.getServerFeaturesSnapshot());
    if (!serverIdentityId) return false;
    return input.session.runSessionFollowSourceRequest({ credentials: input.credentials, request: async () => {
      const { addressing } = observation;
      const read = { serverId: binding.serverId, addressing, discussionAction, signal };
      const question = await readDiscussionInputQuestion(read);
      if (!question?.content) return false;
      // Workflow attribution names an execution, not a causal Session original.
      // It cannot become a person-authored request or fabricate Session authority.
      if (question.producerV1?.kind === 'workflow') return false;
      const producer = question.producerV1;
      const reply = { mode: 'return' as const, discussion: addressing };
      // One C1 resolver distinguishes an actual addressed C2 ask from level-
      // controlled watch/information using the opened committed original.
      const delivery = resolveFollowDeliveryV1({ policies: [observation.policy], event: observation.event,
        discussionInput: { addressing, original: question, reply } });
      if (!delivery.selected) return false;
      const messages = await readDiscussionInputMessages({ ...read, question });
      if (!messages) return false;
      let root = question;
      const discussionContext: DiscussionPromptContextEntryV1[] = [];
      for (const ancestor of messages.slice(0, -1).reverse()) {
        root = ancestor;
        if (!root.content) return false;
        const text = readDiscussionPromptText(root.content);
        const author = root.producerV1;
        if (author?.kind === 'workflow') {
          // Workflow output is not a person or a fabricated Session author.
          // Keep its admitted producer facts in the existing metadata arm.
          discussionContext.push({ kind: 'host_reference_metadata', text: JSON.stringify({
            messageRef: root.messageRef, authorAccountId: root.authorAccountId, producerV1: author, text,
          }) });
        } else {
          const displayName = !author && root.accountActor?.profile ? resolveAccountDisplayLabelV1(root.accountActor.profile) : null;
          discussionContext.push({ author: {
            kind: author ? 'agent_session' : 'person',
            ...(root.authorAccountId ? { accountId: root.authorAccountId } : {}),
            ...(author ? { sessionId: author.sessionId } : {}),
            ...(displayName ? { displayName } : {}),
          }, text });
        }
      }
      // The exact parent walk runs newest-to-oldest; render the admitted
      // background in conversation order without acquiring unrelated history.
      discussionContext.reverse();
      const rootSource = root.replyTarget?.kind === 'doc_passage' ? root.replyTarget.doc : null;
      const passage = 'kind' in question.content ? question.content.kind === 'doc_passage_comment'
        ? question.content.passage : question.content.kind === 'doc_edit_proposal' ? question.content.proposal.target : null : null;
      if (passage && (!rootSource || passage.ref.artifactId !== rootSource.ref.artifactId)) return false;
      if (root.messageRef.discussion.serverId !== binding.serverId
        || root.messageRef.discussion.discussionId !== addressing.discussionId) return false;
      // A redo can carry a newer committed basis than the original thread root.
      // Stored labels belong to the creator's device. Only the exact admitted
      // row's current Home qualifies the compact card and its subsequent reads.
      const source = rootSource ? { ref: { ...rootSource.ref, serverId: root.messageRef.discussion.serverId },
        revision: passage?.revision ?? rootSource.revision } : null;
      // A typed Doc payload must never fall back to serializing its sealed source.
      if (passage && !source) return false;
      let doc: Readonly<{ docRef: NonNullable<typeof source>['ref']; title: string | null;
        revision: NonNullable<typeof source>['revision']; openCommentCount: number | null; threadRef: typeof question.messageRef }> | undefined;
      if (source) {
        let header: Awaited<ReturnType<typeof artifacts.readHeader>>;
        try {
          header = await runWithServerHttpBaseUrl(binding.serverUrl, () => artifacts.readHeader(source.ref.artifactId,
            { signal, prepareRecipients: false }));
        } catch {
          signal.throwIfAborted();
          return false;
        }
        if (!header || header.header.title !== undefined && typeof header.header.title !== 'string') return false;
        const openCommentCount = await countDocPassageThreadsV1(source.ref,
          { surface: 'cli', authority: 'account_automation', serverId: binding.serverId, signal }, discussionAction);
        doc = { docRef: source.ref, title: typeof header.header.title === 'string' ? header.header.title : null, revision: source.revision,
          openCommentCount, threadRef: root.messageRef };
      }
      if (doc) discussionContext.push({ kind: 'host_reference_metadata', text: JSON.stringify({ doc }) });
      const questionText = readDiscussionPromptText(question.content);
      // Keep selected identity in the incumbent Pending metadata so dispatch
      // resolves current contributed context through its existing registry.
      // The intake's readable prompt uses the same canonical marker as its token.
      const mentions = readDiscussionMessagePartsV1(question.content, 'preview').flatMap(part => part.t === 'reference'
        ? [{ ...part.reference, token: formatSessionInputMentionMarkerV1(part.reference) }] : []);
      const referenceMeta = mentions.length ? { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, mentions } } : undefined;
      const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
      const displayName = !producer && question.accountActor?.profile
        ? resolveAccountDisplayLabelV1(question.accountActor.profile) : null;
      const sender: DiscussionPromptAuthorV1 = {
        kind: producer ? 'agent_session' : 'person',
        ...(question.authorAccountId ? { accountId: question.authorAccountId } : {}),
        ...(producer ? { sessionId: producer.sessionId } : {}),
        ...(displayName ? { displayName } : {}),
      };
      if (producer) {
        const producerSessionId = producer.sessionId;
        const roster = DiscussionParticipantsListResponseV1Schema.safeParse(await discussionAction({
          actionId: 'discussion.participants.list', input: { discussionId: addressing.discussionId },
          context: { surface: 'cli', authority: 'account_automation', serverId: binding.serverId }, signal,
        }));
        if (!roster.success || roster.data.discussionId !== addressing.discussionId) return false;
        if (roster.data.participants.some(participant => participant.participant.kind === 'model'
          && 'sessionId' in participant && participant.sessionId === producerSessionId)) sender.kind = 'model';
      }
      // Render after the existing source read has supplied its display identity.
      // Neither the roster label nor the Bot marker supplies causal authority.
      const renderQuestionText = () => renderSessionInputContextPromptV1({
        discussionRequest: { discussionId: addressing.discussionId, messageId: addressing.messageId,
          throughSeq: addressing.throughSeq, sender, ...(doc ? { readActions: ['doc.read'] } : {}) },
        ...(hasDirectDiscussionAnswerObligation({ addressing, original: question, reply }) ? {
          replyObligation: { mode: reply.mode, sessionId: input.session.sessionId, requestLocalId: localId },
        } : {}),
        transformedUserText: questionText,
        ...(discussionContext.length ? { discussionContext } : {}),
      });
      let actionRequestAttributionV1 = materializeActionRequestAttributionV1({
        requestRef: localId, requester: { serverId: serverIdentityId, accountId: question.authorAccountId },
        persona: { serverId: serverIdentityId, sessionId: input.session.sessionId },
        origin: { kind: 'discussion', discussion: { serverId: serverIdentityId, discussionId: addressing.discussionId }, messageId: question.id },
      });
      let admission = buildTrustedHostSessionInputAdmissionV1('agent');
      if (producer) {
        const sourceSession = producer.sourceSession;
        if (!sourceSession?.sourceInputId) return false;
        const serverFeaturesSnapshot = input.session.getServerFeaturesSnapshot();
        const accountId = readAccountIdFromToken(input.credentials.token);
        const foreignSource = Boolean(accountId && question.authorAccountId && question.authorAccountId !== accountId);
        const sourceRead = resolveSessionTransportContext({ reason: 'follow-source-hydration', credentials: input.credentials, idOrPrefix: sourceSession.sourceSessionId,
          signal, ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}) });
        // The authorized presentation read may identify a shared foreign Bot.
        // Unavailable presentation must not replace Pending's private-source hold.
        const source = foreignSource ? await sourceRead.catch(() => { signal.throwIfAborted(); return null; }) : await sourceRead;
        if (source?.ok && source.sessionId === sourceSession.sourceSessionId) {
          const sourceMetadata = readSessionPresentationContent({ credentials: input.credentials, rawSession: source.rawSession,
            accountEncryptionMode: source.accountEncryptionCurrentness.mode }).metadata;
          if (source.sessionId === producer.sessionId) {
            if (sender.kind !== 'model' && readSessionBotV1(sourceMetadata?.bot)) sender.kind = 'bot';
            const summary = sourceMetadata?.summary;
            const summaryText = summary && typeof summary === 'object' && 'text' in summary ? summary.text : null;
            const sessionName = (typeof summaryText === 'string' ? summaryText.trim() : '')
              || (typeof sourceMetadata?.name === 'string' ? sourceMetadata.name.trim() : '');
            if (sessionName) sender.displayName = sessionName;
          }
        }
        if (foreignSource) {
          // This only requests custody. Pending proves the committed producer
          // and retains its own hold; no source authority or permission is made
          // up when the other Account's private original cannot be hydrated.
          const transport = input.session.getMachineAdmissionTransport();
          if (!transport) return false;
          const target = await resolveSessionTransportContext({ reason: 'follow-source-hydration', credentials: input.credentials, idOrPrefix: input.session.sessionId,
            signal, ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}) });
          if (!target.ok) return false;
          const targetMachineId = resolveSessionInputTargetMachineId({ rawSession: target.rawSession,
            decryptedMetadata: tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession: target.rawSession,
              accountEncryptionMode: target.accountEncryptionCurrentness.mode }) });
          if (!targetMachineId) return false;
          const result = await transport({ v: 1, sessionId: input.session.sessionId, targetMachineId, localId,
            requestedAction: { v: 1, kind: 'enqueue' }, reply: { ...reply, sourceSession },
            content: sealSessionStoredContent({ ...target, payload: { role: 'user', content: { type: 'text', text: renderQuestionText() },
              ...(referenceMeta ? { meta: referenceMeta } : {}) },
              idempotencyKey: `session-input:v1:${input.session.sessionId}:${localId}` }),
          }, { timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), signal });
          return result.status === 'accepted' || result.status === 'alreadyAccepted';
        }
        if (!source?.ok || source.sessionId !== sourceSession.sourceSessionId || typeof source.rawSession.workDepth !== 'number') return false;
        const original = await findTranscriptEncryptedMessageByLocalIdV2({ token: input.credentials.token, serverUrl: binding.serverUrl,
          sessionId: sourceSession.sourceSessionId, localId: sourceSession.sourceInputId, signal });
        if (original.type !== 'found' || original.message.messageRole !== 'user') return false;
        const body = openSessionMessageContent({ ...source, content: original.message.content });
        const meta = body && typeof body === 'object' && 'meta' in body ? body.meta : undefined;
        const authority = readSessionInputAuthority(meta, 'stored');
        const causalPermissionAuthority = readSessionInputCausalPermissionAuthorityV1(meta, 'stored');
        const provenance = readSessionMessageProvenance(meta, 'stored') ?? undefined;
        if (authority?.v !== 1 || !causalPermissionAuthority || !provenance) return false;
        assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt: original.message.inputAdmissionReceipt });
        const originalAttribution = deriveSessionInputActionRequestAttributionV1({
          requestRef: original.message.localId, persona: { serverId: serverIdentityId, sessionId: source.sessionId },
          messageRole: original.message.messageRole, inputAdmissionReceipt: original.message.inputAdmissionReceipt, inputAuthority: authority,
          origin: { kind: 'session', session: { serverId: serverIdentityId, sessionId: source.sessionId }, messageId: original.message.id },
        });
        if (!originalAttribution) return false;
        actionRequestAttributionV1 = originalAttribution;
        const turnFacts = stampTurnFacts({ sessionWorkDepth: source.rawSession.workDepth, provenance });
        admission = buildCausalSessionInputAdmissionV1({ ...sourceSession, causalPermissionAuthority, actionRequestAttributionV1,
          callerDepth: readAgentStartCallerWorkDepthV1({ kind: 'session', sessionId: source.sessionId,
            starterDepth: source.rawSession.workDepth, turnDepth: turnFacts.workDepth }) });
      }
      const machineAdmissionTransport = input.session.getMachineAdmissionTransport();
      const result = await sendSessionMessage({ credentials: input.credentials, idOrPrefix: input.session.sessionId,
        localId, wait: false, timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
        message: renderQuestionText(),
        ...(referenceMeta ? { messageMeta: referenceMeta } : {}),
        inputAdmission: { provenance: admission.provenance, request: SessionInputRequestV1Schema.parse({ ...admission.request,
          discussionAddressing: addressing, actionRequestAttributionV1, replyIntent: { mode: reply.mode } }) },
        executionAuthority: 'account_automation', resumeInactiveSession: delivery.session.wake,
        ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
        ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}), signal });
      return result.ok && !result.suppressed;
    } });
  };
}
