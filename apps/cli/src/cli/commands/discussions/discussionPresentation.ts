import { definitionList, ok } from '@happier-dev/cli-common/output';
import { DiscussionCreateResultV1Schema, DiscussionDetailsResultV1Schema, DiscussionListResultV1Schema, DiscussionPostResultV1Schema, DiscussionReadResultV1Schema, DiscussionReadStateResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionMessageContentV1, DiscussionOpenedMessageV1, DiscussionOpenedSummaryV1 } from '@happier-dev/protocol';
import { readDiscussionMessagePartsV1 } from '@happier-dev/protocol/discussions/content';
import { formatSessionInputMentionMarkerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { classifyAccountActorLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';

import type {
  ActionCliPresentation,
  ActionCliPresentationContext,
} from '@/cli/actions/commandPresentation';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

function envelopeKind(context: ActionCliPresentationContext): string {
  return context.command.path.join('_').replace(/-/gu, '_');
}

function successPresentation<T>(params: Readonly<{
  parse: (payload: unknown) => T;
  human: (result: T) => void;
}>): ActionCliPresentation {
  return {
    presentSuccess: async (payload, context) => {
      const result = params.parse(payload);
      if (context.json) {
        await printJsonEnvelope({ ok: true, kind: envelopeKind(context), data: result });
      } else {
        params.human(result);
      }
      return true;
    },
  };
}

function titleOf(discussion: DiscussionOpenedSummaryV1): string {
  return discussion.title ?? '[title unavailable]';
}

function stateOf(discussion: DiscussionOpenedSummaryV1): string {
  const state = discussion.archivedAt === null ? 'active' : 'archived';
  const unread = discussion.unreadCount > 0 ? `, ${discussion.unreadCount} unread` : '';
  const mentions = discussion.unreadMentionCount > 0
    ? `, ${discussion.unreadMentionCount} mention${discussion.unreadMentionCount === 1 ? '' : 's'}`
    : '';
  return `${state}${unread}${mentions}`;
}

function renderSummary(discussion: DiscussionOpenedSummaryV1): string {
  return definitionList([
    { label: titleOf(discussion), value: `${discussion.id} (${stateOf(discussion)})` },
  ]);
}

/**
 * The sanitized display identity this actor projection carries, without the
 * `@` sigil: an author line spells a username `@bo` while a mention already
 * carries its own `@`.
 */
function resolveActorName(actor: DiscussionOpenedMessageV1['accountActor']): Readonly<{
  label: string;
  isUsername: boolean;
}> | null {
  if (!actor) return null;
  const classification = classifyAccountActorLabelV1(actor, false);
  if (classification.kind === 'former') return { label: 'Former member', isUsername: false };
  if (classification.kind !== 'profile') return null;
  return { label: classification.label, isUsername: classification.source === 'username' };
}

/**
 * Mention labels for one read page.
 *
 * The page already carries a sanitized actor projection for every author, so a
 * mention of someone who has spoken here renders as that person rather than as
 * one shared token. Account ids stay out of the human surface (`--json` carries
 * the exact ids), so a mention this page cannot identify keeps the generic
 * member label instead of leaking part of a private id.
 */
export function buildDiscussionMentionLabels(
  messages: readonly DiscussionOpenedMessageV1[],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const message of messages) {
    const accountId = message.accountActor?.accountId ?? message.authorAccountId;
    if (accountId === null || labels.has(accountId)) continue;
    const name = resolveActorName(message.accountActor);
    if (name) labels.set(accountId, name.label);
  }
  return labels;
}

function renderContent(
  content: DiscussionMessageContentV1,
  mentionLabels: ReadonlyMap<string, string>,
): string {
  return readDiscussionMessagePartsV1(content).map((part) => {
    if (part.t === 'text') return part.text;
    if (part.t === 'reference') return formatSessionInputMentionMarkerV1(part.reference);
    if (part.t === 'attachment') return `[${part.attachment.kind === 'folder' ? 'Folder' : 'File'}: ${part.attachment.name}]`;
    return part.participant.kind === 'session'
      ? '@Happier Agent'
      : `@${mentionLabels.get(part.participant.accountId) ?? 'Happier member'}`;
  }).join('');
}

function renderAccountActor(message: DiscussionOpenedMessageV1): string {
  const actor = message.accountActor;
  if (actor === null) return 'Unknown author';
  const name = resolveActorName(actor);
  if (name === null) return 'Happier member';
  return name.isUsername ? `@${name.label}` : name.label;
}

export function formatDiscussionMessageForHuman(
  message: DiscussionOpenedMessageV1,
  mentionLabels: ReadonlyMap<string, string> = new Map(),
): string {
  const actor = renderAccountActor(message);
  const author = message.producerV1?.kind === 'agent' ? `${actor} · Via Agent` : actor;
  const content = message.content === null
    ? '[content unavailable]'
    : renderContent(message.content, mentionLabels);
  return `${message.seq}. ${author}: ${content}`;
}

function readInputString(input: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function createFailureFields(context: ActionCliPresentationContext) {
  const creationLocalId = readInputString(context.input, 'creationLocalId');
  const firstMessage = context.input.firstMessage;
  const messageLocalId = firstMessage && typeof firstMessage === 'object' && !Array.isArray(firstMessage)
    ? readInputString(firstMessage as Readonly<Record<string, unknown>>, 'localId')
    : null;
  return {
    ...(creationLocalId ? { creationLocalId } : {}),
    ...(messageLocalId ? { messageLocalId } : {}),
  };
}

export const DISCUSSION_LIST_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionListResultV1Schema.parse(payload),
  human: (result) => {
    if (result.discussions.length === 0) {
      console.log('(no discussions)');
      return;
    }
    console.log(definitionList(result.discussions.map((discussion) => ({
      label: titleOf(discussion),
      value: `${discussion.id} (${stateOf(discussion)})`,
    }))));
    if (result.incomplete) console.log('Some discussion content is unavailable.');
  },
});

export const DISCUSSION_DETAILS_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(renderSummary(result.discussion)),
});

export const DISCUSSION_READ_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionReadResultV1Schema.parse(payload),
  human: (result) => {
    if (result.messages.length === 0) console.log('(no messages)');
    const mentionLabels = buildDiscussionMentionLabels(result.messages);
    for (const message of result.messages) console.log(formatDiscussionMessageForHuman(message, mentionLabels));
    if (result.hasMoreOlder) console.log('Older messages are available.');
    if (result.incomplete) console.log('Some message content is unavailable.');
  },
});

export const DISCUSSION_CREATE_PRESENTATION: ActionCliPresentation = {
  ...successPresentation({
    parse: (payload) => DiscussionCreateResultV1Schema.parse(payload),
    human: (result) => console.log(ok(`Discussion created: ${titleOf(result.discussion)} (${result.discussion.id})`)),
  }),
  failureFields: (_failure, context) => createFailureFields(context),
  describeFailure: (_failure, context) => {
    const fields = createFailureFields(context);
    return typeof fields.creationLocalId === 'string' && typeof fields.messageLocalId === 'string'
      ? `Retry with --creation-local-id ${fields.creationLocalId} --message-local-id ${fields.messageLocalId}.`
      : null;
  },
};

export const DISCUSSION_POST_PRESENTATION: ActionCliPresentation = {
  ...successPresentation({
    parse: (payload) => DiscussionPostResultV1Schema.parse(payload),
    human: (result) => console.log(ok(`Message posted (sequence ${result.messageSeq}, local id ${result.message.localId ?? 'unavailable'})`)),
  }),
  failureFields: (_failure, context) => {
    const localId = readInputString(context.input, 'localId');
    return localId ? { localId } : null;
  },
  describeFailure: (_failure, context) => {
    const localId = readInputString(context.input, 'localId');
    return localId ? `Retry with --local-id ${localId}.` : null;
  },
};

export const DISCUSSION_RENAME_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion renamed: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const DISCUSSION_ARCHIVE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion archived: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const DISCUSSION_RESTORE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion restored: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const DISCUSSION_READ_STATE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => DiscussionReadStateResultV1Schema.parse(payload),
  human: (result) => console.log(ok(
    result.cursor.didChange
      ? `Discussion marked read through sequence ${result.cursor.lastReadSeq}`
      : `Discussion was already read through sequence ${result.cursor.lastReadSeq}`,
  )),
});
