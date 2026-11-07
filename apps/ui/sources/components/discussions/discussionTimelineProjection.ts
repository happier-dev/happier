import {
  type DiscussionExternalSourceV1,
  DiscussionSelectionSourceV1Schema,
  isDiscussionDocEditProposalContentV1,
  readDiscussionMentionedParticipantIdsV1,
  readDiscussionMessagePartsV1,
} from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { WorkflowInvocationDetailV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowDiscussionRoundProjectResultV1Schema } from '@happier-dev/protocol/workflows/workflowDiscussionRoundV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';

import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import {
  formatAccountDisplayName,
  resolveViewerAccountDisplayName,
} from '@/sync/domains/account/formatAccountDisplayName';
import { resolveAccountActorName, resolveAccountActorPresentation, resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildMentionRefV1, parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1, INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { StoredAttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { readableMessageText, readableMessageTextWithReferences } from '@/components/sessions/transcript/messageDisplayText';
import { projectMessageAttachmentReference, projectMessageMentionReference, readEligibleMessageInlineReferenceTokens, type InlineMessageReference } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { formatSessionInputMentionMarkerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';

type DiscussionMessageReference = InlineMessageReference &
  Readonly<{
    participant?: Extract<
      ReturnType<typeof readDiscussionMessagePartsV1>[number],
      { t: 'mention' }
    >['participant'];
  }>;

/**
 * "Image #N" for a message's pictures, in the order they were attached (the tray's order), as a Session
 * numbers its pictures; the inline chip and the picture's corner badge read this one map.
 */
export function readDiscussionAttachmentImageNumbers(attachments: readonly StoredAttachmentPayloadV1[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const attachment of attachments) {
    if (attachment.kind === 'file' && resolveSessionMediaInlineRenderableImageMimeType({ mimeType: attachment.file.mime, path: attachment.name })) {
      numbers.set(attachment.id, numbers.size + 1);
    }
  }
  return numbers;
}

/** Typed Discussion parts feed the same Markdown inline seam as Session references. */
export function projectDiscussionMessageReferences(
  content: NonNullable<DiscussionOpenedMessageV1['content']>,
  labels: Readonly<{
    account?: (id: string) => string | null;
    session?: (id: string) => string | null;
  }> = {},
  mode?: Parameters<typeof readDiscussionMessagePartsV1>[1],
  /** A thread row draws its files below the body (the Session's tiles and chips), so only authored chips stay inline. */
  unplacedAttachments: 'append' | 'omit' = 'append',
): Readonly<{
  text: string;
  readableText: string;
  inline: ReadonlyMap<string, DiscussionMessageReference>;
  parts: readonly (string | DiscussionMessageReference)[];
}> {
  const declared = new Map<string, DiscussionMessageReference>();
  const attachments = new Map<string, DiscussionMessageReference>();
  const messageParts = readDiscussionMessagePartsV1(content, mode);
  // A thread numbers its pictures as a Session does; a one-line preview keeps their names.
  const imageNumbers = mode === 'preview' ? new Map<string, number>()
    : readDiscussionAttachmentImageNumbers(messageParts.flatMap(part => part.t === 'attachment' ? [part.attachment] : []));
  const sourceParts = messageParts.map(
    (part): string | DiscussionMessageReference => {
      if (part.t === 'text') return part.text;
      // A file the author placed in the text stays a token here; the message's own attachment part resolves it.
      if (part.t === 'reference' && parseMentionRefV1(part.reference.ref)?.scheme === INLINE_REFERENCE_ATTACHMENT_SCHEME_V1) {
        return formatInlineReferenceTokenV1({ label: part.reference.label ?? part.reference.token, ref: part.reference.ref });
      }
      if (part.t === 'reference') {
        const reference = projectMessageMentionReference(part.reference, part.reference.label ?? '');
        if (!reference) return formatSessionInputMentionMarkerV1(part.reference);
        declared.set(reference.ref, reference);
        return reference;
      }
      if (part.t === 'attachment') {
        const imageNumber = imageNumbers.get(part.attachment.id);
        const reference = projectMessageAttachmentReference({ ...part.attachment, ...(imageNumber ? { imageNumber } : {}) });
        declared.set(reference.ref, reference);
        attachments.set(reference.ref, reference);
        return '';
      }
      const account = part.participant.kind === 'account';
      const id =
        part.participant.kind === 'account'
          ? part.participant.accountId
          : part.participant.sessionId;
      const label =
        (account ? labels.account?.(id) : labels.session?.(id)) ??
        t(
          account
            ? 'session.collaboration.discussion.collaborator'
            : 'session.collaboration.discussion.heldParticipant',
        );
      const reference: DiscussionMessageReference = {
        ref: buildMentionRefV1(account ? 'account' : 'session', id),
        kind: account ? 'happier.account' : 'happier.session',
        label,
        marker: `@${label}`,
        glyph: account ? 'assigned' : 'conversations',
        participant: part.participant,
        ...(!account ? { sessionId: id } : {}),
      };
      declared.set(reference.ref, reference);
      return reference;
    },
  );
  let text = sourceParts.map(part => typeof part === 'string' ? part : formatInlineReferenceTokenV1(part)).join('');
  const inline = new Map<string, DiscussionMessageReference & { tokenStarts: Set<number> }>();
  for (const token of readEligibleMessageInlineReferenceTokens(text)) {
    const reference = declared.get(token.ref);
    if (!reference || reference.token !== undefined && reference.token !== text.slice(token.start, token.end)) continue;
    const existing = inline.get(token.ref);
    if (existing) existing.tokenStarts.add(token.start);
    else inline.set(token.ref, { ...reference, tokenStarts: new Set([token.start]) });
  }
  for (const reference of unplacedAttachments === 'append' ? attachments.values() : []) {
    if (inline.has(reference.ref)) continue;
    const separator = text && !/\s$/u.test(text) ? ' ' : '';
    const start = text.length + separator.length;
    text += separator + formatInlineReferenceTokenV1(reference);
    inline.set(reference.ref, { ...reference, tokenStarts: new Set([start]) });
  }
  const parts: Array<string | DiscussionMessageReference> = [];
  let cursor = 0;
  for (const token of readEligibleMessageInlineReferenceTokens(text)) {
    const reference = inline.get(token.ref);
    if (!reference?.tokenStarts.has(token.start)) continue;
    if (token.start > cursor) parts.push(readableMessageText(text.slice(cursor, token.start)));
    parts.push(reference);
    cursor = token.end;
  }
  if (cursor < text.length) parts.push(readableMessageText(text.slice(cursor)));
  return {
    parts,
    inline,
    text,
    readableText: readableMessageTextWithReferences(text, inline),
  };
}

export type DiscussionMessageLabelResolvers = Readonly<{
  account: (id: string) => string | null;
  session: (id: string) => string | null;
}>;
export const EMPTY_DISCUSSION_MESSAGE_LABELS: DiscussionMessageLabelResolvers = {
  account: () => null,
  session: () => null,
};
type LabelMessage = Pick<DiscussionOpenedMessageV1,
  'id' | 'content' | 'replyTarget' | 'participantDeliveryV1' | 'docEditProposalDispositionV1'>
  & Partial<Pick<DiscussionOpenedMessageV1, 'authorAccountId' | 'producerV1' | 'messageRef'>>;
export type DiscussionMessageLabelProjection = DiscussionMessageLabelResolvers & Readonly<{
  content: LabelMessage['content'];
  parent: LabelMessage | undefined;
  deliveries: LabelMessage['participantDeliveryV1'];
  decider: string | null;
  producer: LabelMessage['producerV1'];
  startsGroup: boolean;
  tracksAuthor: boolean;
  accounts: ReadonlyMap<string, string | null>;
  sessions: ReadonlyMap<string, string | null>;
}>;

function labelsUnchanged(values: ReadonlyMap<string, string | null>, resolve: (id: string) => string | null): boolean {
  for (const [id, label] of values) if (resolve(id) !== label) return false;
  return true;
}

/** Rows consume only their own/quoted references, not a changing whole-history resolver. */
export function projectDiscussionMessageLabels(
  messages: readonly LabelMessage[],
  labels: DiscussionMessageLabelResolvers,
  previous: ReadonlyMap<string, DiscussionMessageLabelProjection> = new Map<string, DiscussionMessageLabelProjection>(),
): ReadonlyMap<string, DiscussionMessageLabelProjection> {
  const byId = new Map(messages.map(message => [message.id, message]));
  let changed: Map<string, DiscussionMessageLabelProjection> | null = null;
  for (const [index, message] of messages.entries()) {
    const known = previous.get(message.id);
    const parent = message.replyTarget?.kind === 'message' ? byId.get(message.replyTarget.messageId) : undefined;
    const disposition = message.docEditProposalDispositionV1;
    const decider = disposition && disposition.state !== 'open' ? disposition.decidedBy.accountId : null;
    const previousMessage = messages[index - 1];
    const startsGroup = startsDiscussionMessageGroup(
      { authorAccountId: message.authorAccountId ?? null, producerV1: message.producerV1 ?? null, content: message.content ?? null },
      previousMessage
        ? { authorAccountId: previousMessage.authorAccountId ?? null, producerV1: previousMessage.producerV1 ?? null, content: previousMessage.content ?? null }
        : undefined,
    );
    const tracksAuthor = Boolean(!message.producerV1 && message.authorAccountId
      && (startsGroup || message.content !== null && message.messageRef !== undefined));
    if (known && known.content === message.content && known.parent === parent
      && known.deliveries === message.participantDeliveryV1 && known.decider === decider
      && known.producer === message.producerV1 && known.startsGroup === startsGroup && known.tracksAuthor === tracksAuthor
      && labelsUnchanged(known.accounts, labels.account) && labelsUnchanged(known.sessions, labels.session)) continue;
    const accountIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const content of [message.content, parent?.content]) if (content) {
      const mentioned = readDiscussionMentionedParticipantIdsV1(content);
      for (const id of mentioned.mentionedAccountIds) accountIds.add(id);
      for (const id of mentioned.mentionedSessionIds) sessionIds.add(id);
    }
    // Visible person labels read the thread's latest reconciled Account presentation,
    // not an older row-local actor snapshot. A committed human row with content exposes
    // actions even when it continues a group; an optimistic/unreadable continuation does not.
    // Recording only rendered human-label dependencies keeps unrelated rows stable.
    if (tracksAuthor && message.authorAccountId) accountIds.add(message.authorAccountId);
    if (parent && !parent.producerV1 && parent.authorAccountId) accountIds.add(parent.authorAccountId);
    const requesterAccountId = message.producerV1?.kind === 'agent'
      ? message.producerV1.actionRequestAttributionV1?.requester?.accountId ?? null
      : null;
    if (requesterAccountId) accountIds.add(requesterAccountId);
    if (decider) accountIds.add(decider);
    if (message.producerV1?.kind === 'agent') sessionIds.add(message.producerV1.sessionId);
    for (const delivery of message.participantDeliveryV1 ?? []) sessionIds.add(delivery.participantSessionId);
    const accounts = new Map<string, string | null>();
    const sessions = new Map<string, string | null>();
    for (const id of accountIds) accounts.set(id, labels.account(id));
    for (const id of sessionIds) sessions.set(id, labels.session(id));
    changed ??= new Map(previous);
    changed.set(message.id, {
      content: message.content, parent, deliveries: message.participantDeliveryV1, decider, producer: message.producerV1, startsGroup, tracksAuthor, accounts, sessions,
      account: accounts.size ? id => accounts.get(id) ?? null : EMPTY_DISCUSSION_MESSAGE_LABELS.account,
      session: sessions.size ? id => sessions.get(id) ?? null : EMPTY_DISCUSSION_MESSAGE_LABELS.session,
    });
  }
  for (const id of previous.keys()) if (!byId.has(id)) {
    changed ??= new Map(previous);
    changed.delete(id);
  }
  return changed ?? previous;
}

/** Readable message content as one preview line; unknown mentions never expose raw ids. */
export function readDiscussionMessagePreview(
  content: DiscussionOpenedMessageV1['content'],
  labels: Readonly<{
    account?: (accountId: string) => string | null;
    session?: (sessionId: string) => string | null;
  }> = {},
): string | null {
  if (!content) return null;
  const text = projectDiscussionMessageReferences(content, labels, 'preview')
    .readableText.replace(/\s+/g, ' ')
    .trim();
  if (isDiscussionDocEditProposalContentV1(content)) {
    const title = t('artifacts.browser.proposal.title');
    return text ? `${title} · ${text}` : title;
  }
  return text || null;
}

/** Display-only: an unacknowledged own row borrows only the exact viewer's profile. */
export function resolveDiscussionMessageAuthorLabel(
  message: Pick<
    DiscussionOpenedMessageV1,
    'authorAccountId' | 'accountActor' | 'createdAt'
  >,
  viewer?: Readonly<{
    serverId?: string;
    accountId: string;
    profile: Readonly<{
      name?: string | null;
      username?: string | null;
    }> | null;
  }>,
): string {
  const actor = message.accountActor;
  if (actor === null || actor.accountId !== message.authorAccountId) {
    if (
      actor === null &&
      message.createdAt === 0 &&
      viewer &&
      message.authorAccountId === viewer.accountId
    ) {
      return resolveViewerAccountDisplayName(
        viewer.profile ? formatAccountDisplayName(viewer.profile) : null,
      );
    }
    return t('session.collaboration.discussion.collaborator');
  }
  return resolveAccountActorName(actor, Boolean(viewer?.serverId && message.authorAccountId === viewer.accountId));
}

type DiscussionExternalSourceCarrier = Partial<Pick<DiscussionOpenedMessageV1, 'content'>>;

/**
 * Channel provenance on an inbound message (email, chat): display only. The outside sender chose these
 * names, so they never stand for a member, and the Account that posted the message is the connection's custody.
 */
export function readDiscussionExternalSource(message: DiscussionExternalSourceCarrier): DiscussionExternalSourceV1 | null {
  const content = message.content;
  return content && 'externalSource' in content && content.externalSource ? content.externalSource : null;
}

export type DiscussionMessageSpeakerKind = 'person' | 'agent' | 'workflow' | 'external';

/** The kind of speaker a message shows: a member, an Agent's Session, a Workflow Run, or someone outside Happier. */
export function resolveDiscussionMessageSpeakerKind(
  message: DiscussionExternalSourceCarrier & Partial<Pick<DiscussionOpenedMessageV1, 'producerV1'>>,
): DiscussionMessageSpeakerKind {
  if (message.producerV1?.kind === 'agent') return 'agent';
  if (message.producerV1?.kind === 'workflow') return 'workflow';
  return readDiscussionExternalSource(message) ? 'external' : 'person';
}

/**
 * The external conversation a reply would leave Happier for: replies under an inbound channel message, at any
 * depth, are sent out to that conversation by its connection.
 */
export function resolveDiscussionOutwardReply(
  messageId: string | null,
  messageById: ReadonlyMap<string, DiscussionExternalSourceCarrier & Partial<Pick<DiscussionOpenedMessageV1, 'replyTarget'>>>,
): DiscussionExternalSourceV1 | null {
  const visited = new Set<string>();
  for (let id = messageId; id !== null && !visited.has(id);) {
    visited.add(id);
    const message = messageById.get(id);
    if (!message) return null;
    const source = readDiscussionExternalSource(message);
    if (source) return source;
    id = message.replyTarget?.kind === 'message' ? message.replyTarget.messageId : null;
  }
  return null;
}

export type DiscussionMessageSpeakerLabelResolvers = Readonly<{
  account?: (accountId: string) => string | null;
  session: (sessionId: string) => string | null;
  workflowRun: (runId: string) => string | null;
}>;

/**
 * One display owner for who spoke a Discussion message. The Account that executed an Agent or
 * Workflow publication is custody, not speaker identity: Agents speak as their Session and
 * Workflows speak as their Run everywhere the message is quoted, replied to, or summarized.
 */
export function resolveDiscussionMessageSpeakerLabel(
  message: Pick<
    DiscussionOpenedMessageV1,
    'authorAccountId' | 'accountActor' | 'createdAt'
  > & Partial<Pick<DiscussionOpenedMessageV1, 'producerV1' | 'content'>>,
  labels: DiscussionMessageSpeakerLabelResolvers,
  viewer?: Parameters<typeof resolveDiscussionMessageAuthorLabel>[1],
): string {
  const producer = message.producerV1;
  if (producer?.kind === 'agent') {
    return (
      labels.session(producer.sessionId) ??
      t('session.collaboration.discussion.heldParticipant')
    );
  }
  if (producer?.kind === 'workflow') {
    return labels.workflowRun(producer.runId) ?? t('workflows.run.untitled');
  }
  const external = readDiscussionExternalSource(message);
  if (external) return external.senderDisplayName ?? t('session.collaboration.discussion.externalSender');
  if (message.authorAccountId) {
    const currentAccountLabel = labels.account?.(message.authorAccountId);
    if (currentAccountLabel !== undefined && currentAccountLabel !== null) return currentAccountLabel;
  }
  return resolveDiscussionMessageAuthorLabel(message, viewer);
}

/**
 * A Bot reply's quiet byline (C7): who asked, from the cause the append owner stamped. The row's
 * speaker already names the Bot that answered, so the byline does not repeat it. The requester's
 * name comes only from the sanitized projection for that exact Account; an unprojected or mismatched requester stays "another person", never the Bot's owner or poster. No
 * person cause (autonomous or older replies) says nothing. "Using <account>" is not offered: the reply
 * custody carries no exact outward-operation actor.
 */
export function resolveDiscussionReplyAttributionLine(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'> &
    Partial<Pick<DiscussionOpenedMessageV1, 'requesterAccountActor'>>,
  viewer: Readonly<{ serverId: string; accountId: string }>,
  labels?: Pick<DiscussionMessageSpeakerLabelResolvers, 'account'>,
): string | null {
  const producer = message.producerV1;
  const requester =
    producer?.kind === 'agent'
      ? producer.actionRequestAttributionV1?.requester
      : undefined;
  if (!requester) return null;
  const actor = message.requesterAccountActor;
  const name =
    requester.accountId === viewer.accountId &&
    areServerProfileIdentifiersEquivalent(requester.serverId, viewer.serverId)
      ? t('session.collaboration.discussion.attribution.you')
      : labels?.account?.(requester.accountId) ?? (actor && actor.accountId === requester.accountId
        ? resolveAccountActorPresentation(
            { ...actor, serverId: requester.serverId },
            viewer,
          ).name
        : resolveUnknownAccountActorName('sentence'));
  return t('session.collaboration.discussion.attribution.askedBy', {
    requester: name,
  });
}

/**
 * How an addressed participant answered (C3 U2), read only from the return the append owner stamped on its
 * reply. `failed` includes a turn that ended with no result: either way the person who asked got no answer.
 * A message an agent posted on its own, or a person's message, has no outcome.
 */
export type DiscussionReplyOutcome = 'answer' | 'pass' | 'failed' | 'cancelled';
type StampedReplyOutcome = Extract<
  NonNullable<DiscussionOpenedMessageV1['producerV1']>,
  { kind: 'workflow' }
>['outcome'];
function projectReplyOutcome(
  outcome: StampedReplyOutcome | undefined,
): DiscussionReplyOutcome | null {
  switch (outcome) {
    case 'answer':
      return 'answer';
    case 'pass':
      return 'pass';
    case 'failed':
    case 'terminal_no_result':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
export function resolveDiscussionReplyOutcome(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): DiscussionReplyOutcome | null {
  const producer = message.producerV1;
  return producer?.kind === 'agent'
    ? projectReplyOutcome(producer.replyReturn?.outcome)
    : null;
}

/**
 * A message published for a Workflow (C4): an Agent's protected reply return carries the exact
 * Workflow Run; its generic runId can identify an ordinary execution run. Producer kind still owns
 * speaker identity; the stamped outcome distinguishes a published answer from a pass, failure or stop.
 */
export function resolveDiscussionWorkflowAttribution(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): Readonly<{ runId: string; outcome: DiscussionReplyOutcome | null }> | null {
  const producer = message.producerV1;
  if (!producer) return null;
  const runId = producer.kind === 'workflow' ? producer.runId : producer.replyReturn?.workflow?.runId;
  if (!runId) return null;
  return {
    runId,
    outcome: projectReplyOutcome(
      producer.kind === 'workflow' ? producer.outcome : producer.replyReturn?.outcome,
    ),
  };
}

/**
 * How a message reads in the thread (C3 DISC-19). A reply that stopped but kept a partial answer is
 * still an answer worth reading, so it renders as a message marked stopped. Passed, failed and
 * bodiless stopped replies say nothing anyone has to read past: a compact notice under their byline.
 */
export type DiscussionReplyPresentation =
  | Readonly<{ kind: 'message'; stopped: boolean }>
  | Readonly<{
      kind: 'notice';
      outcome: Exclude<DiscussionReplyOutcome, 'answer'>;
    }>;
function readStampedOutcome(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): DiscussionReplyOutcome | null {
  return (
    resolveDiscussionReplyOutcome(message) ??
    resolveDiscussionWorkflowAttribution(message)?.outcome ??
    null
  );
}
export function resolveDiscussionReplyPresentation(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1' | 'content'>,
): DiscussionReplyPresentation {
  const outcome = readStampedOutcome(message);
  if (outcome === null || outcome === 'answer')
    return { kind: 'message', stopped: false };
  const hasBody =
    message.content !== null &&
    projectDiscussionMessageReferences(message.content).readableText.trim() !==
      '';
  return outcome === 'cancelled' && hasBody
    ? { kind: 'message', stopped: true }
    : { kind: 'notice', outcome };
}

function discussionMessageProducerClass(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): string {
  // Each producer speaks for itself: two Sessions or two Runs in a row never share one byline.
  const producer = message.producerV1;
  if (producer === null) return 'human';
  return producer.kind === 'agent'
    ? `agent:${producer.sessionId}`
    : `workflow:${producer.runId}`;
}

/**
 * Whether a message opens its own speaker group (byline and face). A reply with a stamped outcome
 * always does: it answers one question, and must never read as part of the message before it.
 */
export function startsDiscussionMessageGroup(
  message: Pick<DiscussionOpenedMessageV1, 'authorAccountId' | 'producerV1'> & DiscussionExternalSourceCarrier,
  previous:
    | (Pick<DiscussionOpenedMessageV1, 'authorAccountId' | 'producerV1'> & DiscussionExternalSourceCarrier)
    | undefined,
): boolean {
  // An outside sender is never a continuation of the member whose connection posted for them, or of another sender.
  const externalSpeaker = (entry: DiscussionExternalSourceCarrier) => {
    const source = readDiscussionExternalSource(entry);
    return source ? `${source.conversationDisplayName}\u0000${source.senderDisplayName ?? ''}` : null;
  };
  return (
    !previous ||
    externalSpeaker(previous) !== externalSpeaker(message) ||
    readStampedOutcome(message) !== null ||
    message.authorAccountId === null ||
    previous.authorAccountId === null ||
    previous.authorAccountId !== message.authorAccountId ||
    discussionMessageProducerClass(previous) !==
      discussionMessageProducerClass(message)
  );
}

/**
 * The typed value of a Workflow result, readable beside its summary. A value that only repeats the
 * summary adds nothing and is not shown again; structured values read as indented JSON.
 */
export function readDiscussionWorkflowResultDetail(
  content: DiscussionOpenedMessageV1['content'],
): string | null {
  if (!content || !('kind' in content) || content.kind !== 'workflow_result')
    return null;
  const { value, summary } = content;
  if (typeof value === 'string')
    return value.trim() === '' || value.trim() === summary.trim()
      ? null
      : value;
  return value !== null && typeof value === 'object'
    ? JSON.stringify(value, null, 2)
    : String(value);
}

/**
 * Where a shared Bot's requester-bound request reads in the thread (C7 "External write needs
 * confirmation"): under the Bot reply stamped with the same admitted cause, else under the message
 * that asked. A one-line outcome (passed, failed, stopped) is not a place for a card, so the ask keeps
 * it. A request whose anchor is not loaded here is not placed rather than guessed.
 */
export function placeDiscussionRequesterApprovals<
  T extends Readonly<{ requestRef: string; originMessageId: string }>,
>(
  messages: ReadonlyArray<Pick<DiscussionOpenedMessageV1, 'id' | 'producerV1'>>,
  approvals: ReadonlyArray<T>,
  previous: ReadonlyMap<string, ReadonlyArray<T>> = new Map<string, ReadonlyArray<T>>(),
): ReadonlyMap<string, ReadonlyArray<T>> {
  const placed = new Map<string, ReadonlyArray<T>>();
  if (approvals.length === 0) return previous.size === 0 ? previous : placed;
  const messageIds = new Set(messages.map((message) => message.id));
  const replyByRequestRef = new Map<string, string>();
  for (const message of messages) {
    const requestRef =
      message.producerV1?.kind === 'agent'
        ? message.producerV1.actionRequestAttributionV1?.requestRef
        : undefined;
    const outcome = resolveDiscussionReplyOutcome(message);
    if (requestRef && (outcome === null || outcome === 'answer'))
      replyByRequestRef.set(requestRef, message.id);
  }
  for (const approval of approvals) {
    const anchor =
      replyByRequestRef.get(approval.requestRef) ??
      (messageIds.has(approval.originMessageId)
        ? approval.originMessageId
        : null);
    if (!anchor) continue;
    placed.set(anchor, [...(placed.get(anchor) ?? []), approval]);
  }
  for (const [id, group] of placed) {
    const known = previous.get(id);
    if (known?.length === group.length && group.every((approval, index) => approval === known[index])) placed.set(id, known);
  }
  return placed.size === previous.size && [...placed].every(([id, group]) => previous.get(id) === group) ? previous : placed;
}

export type DiscussionTimelineMessage = Pick<
  DiscussionOpenedMessageV1,
  'id' | 'seq'
> & Partial<Pick<DiscussionOpenedMessageV1, 'producerV1' | 'addressingV1' | 'participantDeliveryV1' | 'replyTarget'>>;

export type DiscussionWorkflowRound = Readonly<{
  runId: string;
  index: number;
  messageIds: readonly string[];
  digestMessageId: string | null;
  speakerCount: number;
  sitOut: readonly string[];
  allPassed: boolean;
  finished: boolean;
}>;

/** Round identity and outcomes come from the recorded builtin coordinates, never inferred consensus. */
export function projectDiscussionWorkflowRounds<TMessage extends DiscussionTimelineMessage>(params: Readonly<{
  messages: readonly TMessage[];
  run: WorkflowRunSummaryV1;
  invocations: readonly WorkflowInvocationDetailV1[];
}>): readonly DiscussionWorkflowRound[] {
  const rounds = new Map<number, { facts: WorkflowInvocationDetailV1[]; messageIds: string[]; digestMessageId: string | null }>();
  const roundByInvocation = new Map<string, number>();
  const factsById = new Map<string, WorkflowInvocationDetailV1>();
  for (const fact of params.invocations) {
    if (fact.index.runId !== params.run.id) continue;
    const coordinate = fact.progress.invocationPath.scope.find(part => part.kind === 'iteration' && part.blockId === 'rounds');
    if (coordinate?.kind !== 'iteration') continue;
    let round = rounds.get(coordinate.index);
    if (!round) {
      round = { facts: [], messageIds: [], digestMessageId: null };
      rounds.set(coordinate.index, round);
    }
    round.facts.push(fact);
    roundByInvocation.set(fact.index.id, coordinate.index);
    factsById.set(fact.index.id, fact);
  }
  for (const message of params.messages) {
    const producer = message.producerV1;
    if (producer?.kind !== 'workflow' || producer.runId !== params.run.id) continue;
    const index = producer.invocationRecordId ? roundByInvocation.get(producer.invocationRecordId) : undefined;
    if (index === undefined) continue;
    const round = rounds.get(index)!;
    round.messageIds.push(message.id);
    const blockId = producer.invocationRecordId ? factsById.get(producer.invocationRecordId)?.progress.invocationPath.blockId : undefined;
    if (blockId === 'default-digest' || blockId === 'selected-digest') round.digestMessageId = message.id;
  }
  let latest = -1;
  for (const index of rounds.keys()) latest = Math.max(latest, index);
  const latestFact = (facts: readonly WorkflowInvocationDetailV1[], blockId: string) => facts.reduce<WorkflowInvocationDetailV1 | undefined>((found, fact) =>
    fact.progress.invocationPath.blockId === blockId && fact.index.lifecycle !== 'superseded'
      && (!found || BigInt(fact.index.sequence) > BigInt(found.index.sequence)) ? fact : found, undefined);
  return [...rounds].sort(([left], [right]) => left - right).flatMap(([index, round]) => {
    if (round.messageIds.length === 0) return [];
    const preparation = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(latestFact(round.facts, 'context')?.progress.result);
    const outcome = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(latestFact(round.facts, 'outcomes')?.progress.result);
    const priorOutcome = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(latestFact(rounds.get(index - 1)?.facts ?? [], 'outcomes')?.progress.result);
    const passed = priorOutcome.success ? priorOutcome.data.outcomeReferences.filter(ref => ref.kind === 'pass') : [];
    const digest = latestFact(round.facts, 'default-digest') ?? latestFact(round.facts, 'selected-digest');
    const replySlots = new Set(round.facts.filter(fact => fact.progress.invocationPath.blockId === 'reply')
      .map(fact => JSON.stringify([fact.index.parentRecordId, fact.index.memberOrdinal])));
    const allPassed = outcome.success && outcome.data.allPassed;
    return [{ runId: params.run.id, index, messageIds: round.messageIds, digestMessageId: round.digestMessageId,
      speakerCount: preparation.success ? preparation.data.nextParticipants.length : replySlots.size,
      sitOut: passed.flatMap(ref => ref.executionSessionId ? [ref.executionSessionId]
        : ref.participant.kind === 'session' ? [ref.participant.session.sessionId] : []),
      allPassed,
      // A failed or stopped current round keeps its partial replies and recovery visible.
      finished: digest?.index.lifecycle === 'completed' || index < latest || allPassed || params.run.state === 'succeeded' }];
  });
}

export type DiscussionTimelineMessageRow<TMessage extends DiscussionTimelineMessage = DiscussionOpenedMessageV1> = Readonly<{
      kind: 'human_message';
      message: TMessage;
      labels?: DiscussionMessageLabelProjection;
    }>;

export type DiscussionTimelineItem<
  TMessage extends DiscussionTimelineMessage = DiscussionOpenedMessageV1,
> =
  | DiscussionTimelineMessageRow<TMessage>
  | Readonly<{
      /** The original question's admitted Session, until its stamped return is loaded. */
      kind: 'participant_reply';
      message: TMessage;
      sessionId: string;
      delivery?: NonNullable<DiscussionOpenedMessageV1['participantDeliveryV1']>[number];
    }>
  | Readonly<{
      kind: 'workflow_round';
      round: DiscussionWorkflowRound;
      rows: readonly DiscussionTimelineMessageRow<TMessage>[];
    }>
  | Readonly<{
      kind: 'agent_activity_reference';
      anchorSeq: number;
      entry: AgentActivityEntry;
      subagent: SessionSubagent;
    }>
  | Readonly<{
      /** A managed Pattern run, shown right under the message that started it. */
      kind: 'workflow_run';
      run: WorkflowRunSummaryV1;
      /** A `workflow_run_end` closes it below its last published reply, so its operations live there. */
      endRow?: true;
    }>
  | Readonly<{
      /** The quiet end row after a finished run's last published reply here (lab T4 FD). */
      kind: 'workflow_run_end';
      run: WorkflowRunSummaryV1;
    }>;

type AgentActivityReference = Extract<
  DiscussionTimelineItem,
  { kind: 'agent_activity_reference' }
>;

function compareReferences(
  left: AgentActivityReference,
  right: AgentActivityReference,
): number {
  const leftStartedAt = left.entry.startedAtMs;
  const rightStartedAt = right.entry.startedAtMs;
  if (leftStartedAt !== rightStartedAt) {
    if (leftStartedAt === null) return 1;
    if (rightStartedAt === null) return -1;
    return leftStartedAt - rightStartedAt;
  }
  return (left.entry.runId ?? '').localeCompare(right.entry.runId ?? '');
}

/**
 * Joins already loaded Discussion rows to the canonical Session Agent roster.
 *
 * Launch provenance is display-only: every referenced message must already be present in this
 * exact Discussion page, and the exact Run must resolve through the canonical activity owner.
 * Missing data omits the card; this function never fetches or authorizes anything.
 */
export function buildDiscussionTimelineItems<
  TMessage extends DiscussionTimelineMessage,
>(
  params: Readonly<{
    serverId: string;
    discussionId: string;
    messages: readonly TMessage[];
    subagents: readonly SessionSubagent[];
    readExecutionRunEntry: (runId: string) => AgentActivityEntry | null;
    /** The authorized managed Run list for this Discussion; a Run whose starting message isn't loaded waits for it. */
    workflowRuns?: readonly WorkflowRunSummaryV1[];
    /** Each Run's committed replies published here (`projectWorkflowRunPublishedAnswerIds`); a finished Run ends after its last. */
    workflowRunAnswerIds?: ReadonlyMap<string, readonly string[]>;
    workflowRounds?: readonly DiscussionWorkflowRound[];
    messageLabels?: ReadonlyMap<string, DiscussionMessageLabelProjection>;
  }>,
  previous: readonly DiscussionTimelineItem<TMessage>[] = [],
): readonly DiscussionTimelineItem<TMessage>[] {
  const previousMessages = new Map<string, Extract<DiscussionTimelineItem<TMessage>, { kind: 'human_message' }>>();
  const previousRuns = new Map<string, Extract<DiscussionTimelineItem<TMessage>, { kind: 'workflow_run' }>>();
  const previousRunEnds = new Map<string, Extract<DiscussionTimelineItem<TMessage>, { kind: 'workflow_run_end' }>>();
  const previousRounds = new Map<string, Extract<DiscussionTimelineItem<TMessage>, { kind: 'workflow_round' }>>();
  const roundKey = (runId: string, index: number, messageId: string) => JSON.stringify([runId, index, messageId]);
  const previousReferences = new Map<string, AgentActivityReference>();
  const previousParticipants = new Map<string, Extract<DiscussionTimelineItem<TMessage>, { kind: 'participant_reply' }>>();
  const participantKey = (messageId: string, sessionId: string) => JSON.stringify([messageId, sessionId]);
  for (const item of previous) {
    if (item.kind === 'human_message') previousMessages.set(item.message.id, item);
    else if (item.kind === 'workflow_run') previousRuns.set(item.run.id, item);
    else if (item.kind === 'workflow_run_end') previousRunEnds.set(item.run.id, item);
    else if (item.kind === 'participant_reply') previousParticipants.set(participantKey(item.message.id, item.sessionId), item);
    else if (item.kind === 'workflow_round') {
      for (const row of item.rows) previousMessages.set(row.message.id, row);
      previousRounds.set(roundKey(item.round.runId, item.round.index, item.rows[0]!.message.id), item);
    }
    else previousReferences.set(item.entry.runId ?? item.subagent.id, item);
  }
  const messageById = new Map(
    params.messages.map((message) => [message.id, message]),
  );
  const returnedParticipants = new Set<string>();
  for (const message of params.messages) {
    const producer = message.producerV1;
    if (producer?.kind === 'agent' && producer.replyReturn && message.replyTarget?.kind === 'message'
      && areServerProfileIdentifiersEquivalent(producer.replyReturn.serverId, params.serverId)) {
      returnedParticipants.add(participantKey(message.replyTarget.messageId, producer.sessionId));
    }
  }
  const referencesByAnchorSeq = new Map<number, AgentActivityReference[]>();

  for (const subagent of params.subagents) {
    if (subagent.kind !== 'execution_run') continue;
    const runId = subagent.runRef?.runId;
    if (!runId) continue;

    const sourceResult = DiscussionSelectionSourceV1Schema.safeParse(
      subagent.runRef?.launchOrigin,
    );
    if (!sourceResult.success) continue;
    const source = sourceResult.data;
    if (
      !areServerProfileIdentifiersEquivalent(
        source.serverId,
        params.serverId,
      ) ||
      source.discussionId !== params.discussionId
    )
      continue;

    let anchorSeq = -1;
    let sourceResolved = true;
    for (const messageId of source.messageIds) {
      const message = messageById.get(messageId);
      if (!message) {
        sourceResolved = false;
        break;
      }
      anchorSeq = Math.max(anchorSeq, message.seq);
    }
    if (!sourceResolved || anchorSeq < 0) continue;

    const entry = params.readExecutionRunEntry(runId);
    if (!entry || entry.kind !== 'execution_run' || entry.runId !== runId)
      continue;
    const known = previousReferences.get(runId);
    const reference: AgentActivityReference = known && known.anchorSeq === anchorSeq
      && known.entry === entry && known.subagent === subagent ? known : {
      kind: 'agent_activity_reference',
      anchorSeq,
      entry,
      subagent,
    };
    const atAnchor = referencesByAnchorSeq.get(anchorSeq);
    if (atAnchor) atAnchor.push(reference);
    else referencesByAnchorSeq.set(anchorSeq, [reference]);
  }

  for (const references of referencesByAnchorSeq.values())
    references.sort(compareReferences);

  const workflowRunsByMessageId = new Map<string, WorkflowRunSummaryV1[]>();
  for (const run of params.workflowRuns ?? []) {
    const origin =
      run.origin.kind === 'direct' ? run.origin.discussion : undefined;
    if (
      !origin ||
      origin.discussion.discussionId !== params.discussionId ||
      !areServerProfileIdentifiersEquivalent(
        origin.discussion.serverId,
        params.serverId,
      )
    )
      continue;
    const atMessage = workflowRunsByMessageId.get(origin.messageId);
    if (atMessage) atMessage.push(run);
    else workflowRunsByMessageId.set(origin.messageId, [run]);
  }
  // The thread reads downward in time: Run again starts a newer Run under the same message, below the earlier one.
  for (const runs of workflowRunsByMessageId.values())
    runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  // A finished Run with replies here ends after the last of them that is loaded, in thread order.
  const runEndsAfterMessageId = new Map<string, WorkflowRunSummaryV1[]>();
  const endingRunIds = new Set<string>();
  const threadIndexById = params.workflowRunAnswerIds && params.workflowRunAnswerIds.size > 0
    ? new Map(params.messages.map((message, index) => [message.id, index])) : null;
  for (const runs of threadIndexById ? workflowRunsByMessageId.values() : []) {
    for (const run of runs) {
      if (!isTerminalWorkflowRunState(run.state)) continue;
      let lastIndex = -1;
      for (const answerId of params.workflowRunAnswerIds?.get(run.id) ?? []) {
        lastIndex = Math.max(lastIndex, threadIndexById?.get(answerId) ?? -1);
      }
      const last = params.messages[lastIndex];
      if (last === undefined) continue;
      endingRunIds.add(run.id);
      const atMessage = runEndsAfterMessageId.get(last.id);
      if (atMessage) atMessage.push(run);
      else runEndsAfterMessageId.set(last.id, [run]);
    }
  }

  const items: DiscussionTimelineItem<TMessage>[] = [];
  const startedRunIds = new Set<string>();
  for (const message of params.messages) {
    const labels = params.messageLabels?.get(message.id);
    const known = previousMessages.get(message.id);
    items.push(known?.message === message && known.labels === labels
      ? known : { kind: 'human_message', message, ...(labels ? { labels } : {}) });
    const watchers = new Set(message.addressingV1?.watcherSessionIds ?? []);
    for (const sessionId of message.addressingV1?.participantSessionIds ?? []) {
      const key = participantKey(message.id, sessionId);
      if (watchers.has(sessionId) || returnedParticipants.has(key)) continue;
      const delivery = message.participantDeliveryV1?.find(item => item.participantSessionId === sessionId);
      const previousParticipant = previousParticipants.get(key);
      items.push(previousParticipant?.message === message && previousParticipant.delivery === delivery ? previousParticipant
        : { kind: 'participant_reply', message, sessionId, ...(delivery ? { delivery } : {}) });
    }
    // The end row closes an earlier Run before any Run this message starts.
    for (const run of runEndsAfterMessageId.get(message.id) ?? []) {
      if (!startedRunIds.has(run.id)) continue;
      const knownEnd = previousRunEnds.get(run.id);
      items.push(knownEnd?.run === run ? knownEnd : { kind: 'workflow_run_end', run });
    }
    for (const run of workflowRunsByMessageId.get(message.id) ?? []) {
      startedRunIds.add(run.id);
      const endRow = endingRunIds.has(run.id);
      const knownRun = previousRuns.get(run.id);
      items.push(knownRun?.run === run && (knownRun.endRow === true) === endRow ? knownRun
        : { kind: 'workflow_run', run, ...(endRow ? { endRow: true as const } : {}) });
    }
    items.push(...(referencesByAnchorSeq.get(message.seq) ?? []));
  }
  const roundByMessageId = new Map<string, DiscussionWorkflowRound>();
  for (const round of params.workflowRounds ?? []) {
    if (!startedRunIds.has(round.runId)) continue;
    for (const id of round.messageIds) roundByMessageId.set(id, round);
  }
  const grouped: DiscussionTimelineItem<TMessage>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const round = item.kind === 'human_message' ? roundByMessageId.get(item.message.id) : undefined;
    if (item.kind !== 'human_message' || !round) { grouped.push(item); continue; }
    const rows = [item];
    // Preserve human interruptions and other run/activity rows in their original chronology.
    while (index + 1 < items.length) {
      const next = items[index + 1]!;
      if (next.kind !== 'human_message' || roundByMessageId.get(next.message.id) !== round) break;
      rows.push(next);
      index += 1;
    }
    const known = previousRounds.get(roundKey(round.runId, round.index, item.message.id));
    grouped.push(known?.round === round && known.rows.length === rows.length && rows.every((row, index) => row === known.rows[index])
      ? known : { kind: 'workflow_round', round, rows });
  }
  return grouped.length === previous.length && grouped.every((item, index) => item === previous[index]) ? previous : grouped;
}

/**
 * The canonical rows a reader has actually been shown as readable content.
 *
 * A visible row whose content the Discussion cipher could not open is an
 * unavailable placeholder, not something read. The private cursor is one
 * monotone sequence, so a later readable row must not carry it past an earlier
 * unread unreadable one: only rows before the first retained unreadable row
 * above the confirmed cursor qualify. An unreadable row the cursor already
 * covers was read before and blocks nothing. Optimistic or unknown rows are
 * never in `messages` and never qualify.
 */
export function resolveReadableVisibleDiscussionSeqs(
  input: Readonly<{
    messages: readonly Pick<
      DiscussionOpenedMessageV1,
      'id' | 'seq' | 'content'
    >[];
    visibleMessageIds: ReadonlySet<string>;
    /** The confirmed private read cursor, or null when this viewer has none. */
    lastReadSeq: number | null;
  }>,
): readonly number[] {
  const seqs: number[] = [];
  for (const message of input.messages) {
    if (message.content === null) {
      if (input.lastReadSeq !== null && message.seq <= input.lastReadSeq)
        continue;
      break;
    }
    if (input.visibleMessageIds.has(message.id)) seqs.push(message.seq);
  }
  return seqs;
}
