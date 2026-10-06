import { definitionList, ok } from '@happier-dev/cli-common/output';
import { SessionDiscussionCreateResultV1Schema, SessionDiscussionDetailsResultV1Schema, SessionDiscussionListResultV1Schema, SessionDiscussionPostResultV1Schema, SessionDiscussionReadResultV1Schema, SessionDiscussionReadStateResultV1Schema } from '@happier-dev/protocol/sessions/discussions/actions';
import type { SessionDiscussionMessageContentV1, SessionDiscussionOpenedMessageV1, SessionDiscussionOpenedSummaryV1 } from '@happier-dev/protocol';

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

function titleOf(discussion: SessionDiscussionOpenedSummaryV1): string {
  return discussion.title ?? '[title unavailable]';
}

function stateOf(discussion: SessionDiscussionOpenedSummaryV1): string {
  const state = discussion.archivedAt === null ? 'active' : 'archived';
  const unread = discussion.unreadCount > 0 ? `, ${discussion.unreadCount} unread` : '';
  const mentions = discussion.unreadMentionCount > 0
    ? `, ${discussion.unreadMentionCount} mention${discussion.unreadMentionCount === 1 ? '' : 's'}`
    : '';
  return `${state}${unread}${mentions}`;
}

function renderSummary(discussion: SessionDiscussionOpenedSummaryV1): string {
  return definitionList([
    { label: titleOf(discussion), value: `${discussion.id} (${stateOf(discussion)})` },
  ]);
}

/**
 * The sanitized display identity this actor projection carries, without the
 * `@` sigil: an author line spells a username `@bo` while a mention already
 * carries its own `@`.
 */
function resolveActorName(actor: SessionDiscussionOpenedMessageV1['accountActor']): Readonly<{
  label: string;
  isUsername: boolean;
}> | null {
  const profile = actor?.profile ?? null;
  if (profile === null) return null;
  const fullName = [profile.firstName, profile.lastName]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  if (fullName) return { label: fullName, isUsername: false };
  const username = profile.username?.trim();
  return username ? { label: username, isUsername: true } : null;
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
  messages: readonly SessionDiscussionOpenedMessageV1[],
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
  content: SessionDiscussionMessageContentV1,
  mentionLabels: ReadonlyMap<string, string>,
): string {
  return content.parts.map((part) => (
    part.t === 'text' ? part.text : `@${mentionLabels.get(part.accountId) ?? 'Happier member'}`
  )).join('');
}

function renderAccountActor(message: SessionDiscussionOpenedMessageV1): string {
  const actor = message.accountActor;
  if (actor === null) return 'Unknown author';
  if (actor.profile === null) return 'Former member';
  const name = resolveActorName(actor);
  if (name === null) return 'Happier member';
  return name.isUsername ? `@${name.label}` : name.label;
}

export function formatDiscussionMessageForHuman(
  message: SessionDiscussionOpenedMessageV1,
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

export const SESSION_DISCUSSION_LIST_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionListResultV1Schema.parse(payload),
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

export const SESSION_DISCUSSION_DETAILS_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(renderSummary(result.discussion)),
});

export const SESSION_DISCUSSION_READ_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionReadResultV1Schema.parse(payload),
  human: (result) => {
    if (result.messages.length === 0) console.log('(no messages)');
    const mentionLabels = buildDiscussionMentionLabels(result.messages);
    for (const message of result.messages) console.log(formatDiscussionMessageForHuman(message, mentionLabels));
    if (result.hasMoreOlder) console.log('Older messages are available.');
    if (result.incomplete) console.log('Some message content is unavailable.');
  },
});

export const SESSION_DISCUSSION_CREATE_PRESENTATION: ActionCliPresentation = {
  ...successPresentation({
    parse: (payload) => SessionDiscussionCreateResultV1Schema.parse(payload),
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

export const SESSION_DISCUSSION_POST_PRESENTATION: ActionCliPresentation = {
  ...successPresentation({
    parse: (payload) => SessionDiscussionPostResultV1Schema.parse(payload),
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

export const SESSION_DISCUSSION_RENAME_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion renamed: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const SESSION_DISCUSSION_ARCHIVE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion archived: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const SESSION_DISCUSSION_RESTORE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionDetailsResultV1Schema.parse(payload),
  human: (result) => console.log(ok(`Discussion restored: ${titleOf(result.discussion)} (${result.discussion.id})`)),
});

export const SESSION_DISCUSSION_READ_STATE_PRESENTATION: ActionCliPresentation = successPresentation({
  parse: (payload) => SessionDiscussionReadStateResultV1Schema.parse(payload),
  human: (result) => console.log(ok(
    result.cursor.didChange
      ? `Discussion marked read through sequence ${result.cursor.lastReadSeq}`
      : `Discussion was already read through sequence ${result.cursor.lastReadSeq}`,
  )),
});
