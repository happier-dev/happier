import { countDocPassageThreadsV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { captureDocPassageV1, docPassageEditTargetV1, locateDocPassageThreadV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
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
import { formatDiscussionTriageEntry } from '@/discussions/formatDiscussionTriageEntry';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { classifyAccountActorLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
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
import { buildMentionRefForKindV1, MENTION_BOUNDS, MENTION_KIND_V1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { fetchSessionSnapshotsBatch } from '@/session/transport/http/sessionsHttp';
import { readAccountEncryptionCurrentnessForRead } from '@/api/client/accountEncryptionCurrentnessObservation';

type DiscussionParticipantMention = Extract<ReturnType<typeof readDiscussionMessagePartsV1>[number], { t: 'mention' }>['participant'];

function resolveFollowAccountActorLabel(
  actor: NonNullable<Awaited<ReturnType<typeof readDiscussionInputQuestion>>>['accountActor'],
  isSelf: boolean,
): string | null {
  if (!actor) return null;
  const classification = classifyAccountActorLabelV1(actor, isSelf);
  switch (classification.kind) {
    case 'former': return 'Former member';
    case 'self': return 'You';
    case 'profile': return classification.label;
    case 'unnamed': return 'Happier member';
  }
}

function readSessionName(metadata: ReturnType<typeof readSessionPresentationContent>['metadata']): string {
  const summary = metadata?.summary;
  const summaryText = summary && typeof summary === 'object' && 'text' in summary ? summary.text : null;
  return (typeof summaryText === 'string' ? summaryText.trim() : '')
    || (typeof metadata?.name === 'string' ? metadata.name.trim() : '');
}

function readDiscussionPromptText(content: DiscussionMessageContentV1,
  renderParticipant: (participant: DiscussionParticipantMention) => string): string {
  return readDiscussionMessagePartsV1(content, 'preview').map(part => part.t === 'text' ? part.text
    : part.t === 'reference' ? formatSessionInputMentionMarkerV1(part.reference)
    : part.t === 'attachment' ? `[${part.attachment.kind === 'folder' ? 'Folder' : 'File'}: ${part.attachment.name}]`
    : part.t === 'triage_entry' ? formatDiscussionTriageEntry(part.entry)
    : renderParticipant(part.participant)).join('');
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
      if (!question?.content || !question.addressingV1?.participantSessionIds.includes(addressing.participantSessionId)) return false;
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
      const viewerAccountId = readAccountIdFromToken(input.credentials.token);
      const accountLabels = new Map<string, string>();
      for (const message of messages) {
        const actor = message.accountActor;
        const label = actor ? resolveFollowAccountActorLabel(actor, actor.accountId === viewerAccountId) : null;
        if (actor && label) accountLabels.set(actor.accountId, label);
      }
      const parts = messages.flatMap(message => message.content ? readDiscussionMessagePartsV1(message.content, 'preview') : []);
      const sessionLabels = new Map<string, string>();
      const participantSessionIds = new Set(parts.flatMap(part => part.t === 'mention' && part.participant.kind === 'session'
        ? [part.participant.sessionId] : []));
      // Labels are advisory. Unavailable presentation never removes the selected
      // identity or blocks delivery; authority remains with the existing input owner.
      const peerSessionIds = [...participantSessionIds].filter(sessionId => sessionId !== input.session.sessionId
        && sessionId !== producer?.sessionId);
      if (peerSessionIds.length) {
        try {
          const [snapshots, currentness] = await Promise.all([
            fetchSessionSnapshotsBatch({ token: input.credentials.token, serverUrl: binding.serverUrl,
              sessionIds: peerSessionIds, signal }),
            readAccountEncryptionCurrentnessForRead({ credentials: input.credentials, token: input.credentials.token, signal }),
          ]);
          for (const sessionId of peerSessionIds) {
            const detail = snapshots.get(sessionId)?.detail;
            if (detail?.status !== 200) continue;
            const metadata = readSessionPresentationContent({ credentials: input.credentials, rawSession: detail.body.session,
              accountEncryptionMode: currentness.mode }).metadata;
            const label = readSessionName(metadata);
            if (label) sessionLabels.set(sessionId, label);
          }
        } catch {
          signal.throwIfAborted();
        }
      }
      const participantReference = (sessionId: string): MentionRefV1 => {
        const reference = { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, sessionId),
          label: (sessionLabels.get(sessionId) ?? 'Session').slice(0, MENTION_BOUNDS.maxLabelChars), token: '' };
        return { ...reference, token: formatSessionInputMentionMarkerV1(reference) };
      };
      const promptParticipant = (participant: DiscussionParticipantMention): string => participant.kind === 'session'
        ? participantReference(participant.sessionId).token : '@Person';
      let root = question;
      const discussionContext: DiscussionPromptContextEntryV1[] = [];
      for (const ancestor of messages.slice(0, -1).reverse()) {
        root = ancestor;
        if (!root.content) return false;
        const text = readDiscussionPromptText(root.content, promptParticipant);
        const author = root.producerV1;
        if (author?.kind === 'workflow') {
          // Workflow output is not a person or a fabricated Session author.
          // Keep its admitted producer facts in the existing metadata arm.
          discussionContext.push({ kind: 'host_reference_metadata', text: JSON.stringify({
            messageRef: root.messageRef, authorAccountId: root.authorAccountId, producerV1: author, text,
          }) });
        } else {
          const displayName = !author && root.accountActor
            ? resolveFollowAccountActorLabel(root.accountActor, root.accountActor.accountId === viewerAccountId) : null;
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
      const accountParticipants = [...new Set(parts.flatMap(part => part.t === 'mention' && part.participant.kind === 'account'
        ? [part.participant.accountId] : []))];
      if (accountParticipants.length) discussionContext.push({ kind: 'host_reference_metadata', text: JSON.stringify({
        participants: accountParticipants.map(accountId => ({ kind: 'account', accountId })),
      }) });
      const rootSource = root.replyTarget?.kind === 'doc_passage' ? root.replyTarget.doc : null;
      const passage = 'kind' in question.content ? question.content.kind === 'doc_passage_comment'
        ? question.content.passage : question.content.kind === 'doc_edit_proposal' ? question.content.proposal.target : null : null;
      if (passage && (!rootSource || passage.ref.artifactId !== rootSource.ref.artifactId)) return false;
      if (root.messageRef.discussion.serverId !== binding.serverId
        || root.messageRef.discussion.discussionId !== addressing.discussionId) return false;
      // Stored labels belong to the creator's device. Only the exact admitted
      // row's current Home qualifies the compact card and its subsequent reads.
      const source = rootSource ? { ref: { ...rootSource.ref, serverId: root.messageRef.discussion.serverId } } : null;
      // A typed Doc payload must never fall back to serializing its sealed source.
      if (passage && !source) return false;
      const attachedPassage = passage ?? (root.content && 'kind' in root.content
        ? root.content.kind === 'doc_passage_comment' ? root.content.passage
          : root.content.kind === 'doc_edit_proposal' ? root.content.proposal.target : null : null);
      let currentPassage: typeof attachedPassage = null;
      let doc: Readonly<{ docRef: NonNullable<typeof source>['ref']; title: string | null;
        revision: NonNullable<typeof rootSource>['revision']; openCommentCount: number | null; threadRef: typeof question.messageRef }> | undefined;
      if (source) {
        let artifact: Awaited<ReturnType<typeof artifacts.read>>;
        try {
          artifact = await runWithServerHttpBaseUrl(binding.serverUrl, () => artifacts.read(source.ref.artifactId,
            { signal, prepareRecipients: false, includeSharedAudience: false }));
        } catch {
          signal.throwIfAborted();
          return false;
        }
        if (!artifact || typeof artifact.body !== 'string'
          || artifact.header.title !== undefined && typeof artifact.header.title !== 'string') return false;
        if (attachedPassage) {
          const { location } = locateDocPassageThreadV1({ target: attachedPassage, source: artifact.body,
            revision: artifact.revision, messages, purpose: 'propose' });
          if (location.state !== 'detached') currentPassage = captureDocPassageV1({ ref: source.ref,
            revision: artifact.revision, source: artifact.body, range: location.range });
        }
        const openCommentCount = await countDocPassageThreadsV1(source.ref,
          { surface: 'cli', authority: 'account_automation', serverId: binding.serverId, signal }, discussionAction);
        doc = { docRef: source.ref, title: typeof artifact.header.title === 'string' ? artifact.header.title : null, revision: artifact.revision,
          openCommentCount, threadRef: root.messageRef };
      }
      // Historical proposals are conversation context, never the next edit's basis.
      // Recapture through the proposal placement owner so surrounding human edits survive.
      const contextPassage = currentPassage ?? attachedPassage;
      if (doc) discussionContext.push({ kind: 'host_reference_metadata', text: JSON.stringify({ doc,
        ...(contextPassage ? { documentPassage: {
          revision: contextPassage.revision, quote: contextPassage.quote,
          ...(contextPassage.prefix === undefined ? {} : { prefix: contextPassage.prefix }),
          ...(contextPassage.suffix === undefined ? {} : { suffix: contextPassage.suffix }),
        } } : {}),
        suggestEdit: { actionId: 'doc.edit.propose', discussionRef: doc.threadRef.discussion,
          ...(currentPassage
            ? { before: docPassageEditTargetV1(currentPassage).quote,
              beforeWithSelection: `${currentPassage.prefix}<selected_passage>${currentPassage.quote}</selected_passage>${currentPassage.suffix}` } : {}),
          replacementScope: 'Supply the complete paragraph(s) in suggestEdit.before as after, editing the selected span and keeping all text outside it verbatim unless the request asks otherwise. suggestEdit.beforeWithSelection marks the person\'s highlight with <selected_passage> tags; omit those annotation tags from after. documentPassage.quote is the selected text. after replaces the entire before verbatim. before is captured from the current Doc at intake; historical suggestions are not its basis. If before is absent or the Doc changed, use doc.read and apply the same selection-only edit to the complete current paragraph(s) containing the passage.',
        },
      }) });
      // Keep selected identity in the incumbent Pending metadata so dispatch
      // resolves current contributed context through its existing registry.
      // The intake's readable prompt uses the same canonical marker as its token.
      const readMentions = () => [...parts.flatMap(part => part.t === 'reference'
        ? [{ ...part.reference, token: formatSessionInputMentionMarkerV1(part.reference) }] : []),
        ...[...participantSessionIds].map(participantReference)];
      const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
      const displayName = !producer && question.accountActor
        ? resolveFollowAccountActorLabel(question.accountActor, question.accountActor.accountId === viewerAccountId) : null;
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
        for (const actor of roster.data.accountActors ?? []) {
          const label = resolveFollowAccountActorLabel(actor, actor.accountId === viewerAccountId);
          if (label) accountLabels.set(actor.accountId, label);
        }
        if (roster.data.participants.some(participant => participant.participant.kind === 'model'
          && 'sessionId' in participant && participant.sessionId === producerSessionId)) sender.kind = 'model';
      }
      // `text` is the provider prompt; the transcript shows the authored message
      // (`displayText`), so sender ids and context blocks never reach the bubble.
      // Addressing this Session is implied by its own transcript.
      const messageMeta = () => {
        const mentions = readMentions();
        const displayText = readDiscussionPromptText(question.content!, participant =>
          participant.kind === 'session' && participant.sessionId === input.session.sessionId ? ''
            : participant.kind === 'session' && participant.sessionId === sender.sessionId && sender.displayName
              ? `@${sender.displayName}` : participant.kind === 'session'
                ? formatSessionInputMentionMarkerV1(participantReference(participant.sessionId))
                : `@${accountLabels.get(participant.accountId) ?? 'Person'}`).trim();
        return { ...(mentions.length ? { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, mentions } } : {}),
          ...(displayText ? { displayText } : {}) };
      };
      // Render after the existing source read has supplied its display identity.
      // Neither the roster label nor the Bot marker supplies causal authority.
      const renderQuestionText = () => renderSessionInputContextPromptV1({
        discussionRequest: { discussionId: addressing.discussionId, messageId: addressing.messageId,
          throughSeq: addressing.throughSeq, sender, ...(doc ? { readActions: ['doc.read'] } : {}) },
        ...(hasDirectDiscussionAnswerObligation({ addressing, original: question, reply }) ? {
          replyObligation: { mode: reply.mode, sessionId: input.session.sessionId, requestLocalId: localId },
        } : {}),
        transformedUserText: readDiscussionPromptText(question.content!, promptParticipant),
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
        const foreignSource = Boolean(viewerAccountId && question.authorAccountId && question.authorAccountId !== viewerAccountId);
        const sourceRead = resolveSessionTransportContext({ reason: 'follow-source-hydration', credentials: input.credentials, idOrPrefix: sourceSession.sourceSessionId,
          signal, usage: 'read', ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}) });
        // The authorized presentation read may identify a shared foreign Bot.
        // Unavailable presentation must not replace Pending's private-source hold.
        const source = foreignSource ? await sourceRead.catch(() => { signal.throwIfAborted(); return null; }) : await sourceRead;
        if (source?.ok && source.sessionId === sourceSession.sourceSessionId) {
          const sourceMetadata = readSessionPresentationContent({ credentials: input.credentials, rawSession: source.rawSession,
            accountEncryptionMode: source.accountEncryptionCurrentness.mode }).metadata;
          if (source.sessionId === producer.sessionId) {
            if (sender.kind !== 'model' && readSessionBotV1(sourceMetadata?.bot)) sender.kind = 'bot';
            const sessionName = readSessionName(sourceMetadata);
            if (sessionName) {
              sender.displayName = sessionName;
              sessionLabels.set(producer.sessionId, sessionName);
            }
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
              meta: messageMeta() },
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
        messageMeta: messageMeta(),
        inputAdmission: { provenance: admission.provenance, request: SessionInputRequestV1Schema.parse({ ...admission.request,
          discussionAddressing: addressing, actionRequestAttributionV1, replyIntent: { mode: reply.mode } }) },
        executionAuthority: 'account_automation', resumeInactiveSession: delivery.session.wake,
        ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
        ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}), signal });
      return result.ok && !result.suppressed;
    } });
  };
}
