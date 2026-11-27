import {
    DiscussionAccountIdSchema,
    DiscussionTextMessageContentV1Schema,
    type DiscussionTextMessageContentV1,
    type DiscussionMessageContentV1,
} from '@happier-dev/protocol/discussions/content';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { DiscussionIdSchema, type DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import type { DiscussionModelParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import { DiscussionInitialParticipantsV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import {
    MENTION_KIND_V1,
    buildMentionRefV1,
    parseMentionRefV1,
    readMentionRefOpaqueForKindV1,
} from '@happier-dev/protocol/runtime/input/mentionRefV1';

import {
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { composerReferencesFromStructuredMentions } from '@/components/sessions/composer/composerScopeAdapters';
import type { StoredAttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';
import type { PortableComposerAttachmentV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { readTriageEntryComposerAttachmentRefV1 } from '@happier-dev/triage-protocol/v1';
import { isComposerTokenBoundaryChar, parseComposerSuggestionQuery, parseComposerTokenEnd } from '@/components/autocomplete/composerSuggestionGrammar';

/** Unselected @ queries stay text; Send asks the author to acknowledge that explicitly. */
export function readUnresolvedDiscussionMentionTokens(
    text: string,
    mentions: readonly ComposerStructuredInputMention[],
): string[] {
    const selected = parseComposerStructuredInputMentionsForText(mentions, text).mentions;
    const unresolved: string[] = [];
    let selectedIndex = 0;
    for (let index = 0; index < text.length; index += 1) {
        while (selected[selectedIndex] && selected[selectedIndex]!.end <= index) selectedIndex += 1;
        const mention = selected[selectedIndex];
        if (mention && index >= mention.start) {
            index = mention.end - 1;
            continue;
        }
        if (text.charAt(index) !== '@' || !isComposerTokenBoundaryChar(text.charAt(index - 1))) continue;
        const end = parseComposerTokenEnd(text, index, text.length);
        const token = text.slice(index, end);
        if (parseComposerSuggestionQuery(token)?.query.trim()) unresolved.push(token);
        index = end - 1;
    }
    return unresolved;
}

/** The passage travels inside C3's admitted content, beside the human comment. */
export function prepareDiscussionContentForPassage(input: Readonly<{
    content: DiscussionMessageContentV1;
    passage: DocPassageRefV1 | null | undefined;
}>): DiscussionMessageContentV1 {
    return input.passage ? { kind: 'doc_passage_comment', passage: input.passage,
        content: DiscussionTextMessageContentV1Schema.parse(input.content) } : input.content;
}

/** Chip defaults become the same strict mention parts as the structured @ owner. */
export function prepareDiscussionContentForRecipients(input: Readonly<{
    content: DiscussionMessageContentV1;
    recipients: readonly DiscussionParticipantRefV1[];
    replyTarget?: DiscussionReplyTargetV1;
}>): DiscussionMessageContentV1 {
    if (input.replyTarget || input.recipients.length === 0) return input.content;
    const content = 'kind' in input.content
        ? input.content.kind === 'doc_passage_comment' ? input.content.content : null
        : input.content;
    if (!content || content.parts.some(part => part.t === 'mention')) return input.content;
    const addressed = DiscussionTextMessageContentV1Schema.parse({ v: 1, parts: [
        ...DiscussionInitialParticipantsV1Schema.parse(input.recipients).flatMap(participant => [
            { t: 'mention' as const, participant }, { t: 'text' as const, text: ' ' },
        ]),
        ...content.parts,
    ] });
    return 'kind' in input.content && input.content.kind === 'doc_passage_comment'
        ? { ...input.content, content: addressed } : addressed;
}

/** Reads the immutable passage basis from already opened Discussion content. */
export function readDiscussionContentPassage(content: DiscussionMessageContentV1 | null | undefined): DocPassageRefV1 | null {
    if (!content || !('kind' in content)) return null;
    switch (content.kind) {
        case 'doc_passage_comment': return content.passage;
        case 'doc_edit_proposal': return content.proposal.target;
        case 'workflow_result': return null;
    }
}

/** Discussion-only identities remain inert until the committed post owner admits addressing. */
export const DISCUSSION_ACCOUNT_MENTION_KIND = 'happier.account';
const DISCUSSION_ACCOUNT_MENTION_REF_SCHEME = 'account';
export const DISCUSSION_MODEL_SLOT_MENTION_KIND = 'happier.discussionParticipant';
const DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME = 'discussion-participant';

export function buildDiscussionModelSlotMentionPayload(participantSlotId: string, label: string) {
    return { kind: DISCUSSION_MODEL_SLOT_MENTION_KIND,
        ref: buildMentionRefV1(DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME, participantSlotId), label };
}

export function buildDiscussionAccountMentionPayload(accountId: string, label: string): Readonly<{
    kind: string;
    ref: string;
    label: string;
}> {
    return { kind: DISCUSSION_ACCOUNT_MENTION_KIND, ref: buildMentionRefV1(DISCUSSION_ACCOUNT_MENTION_REF_SCHEME, accountId), label };
}

/** The send/admission projection of a typed composer reference, never an identity parsed from text. */
export function readDiscussionMentionParticipant(
    mention: ComposerStructuredInputMention,
): DiscussionParticipantRefV1 | DiscussionModelParticipantV1['participant'] | null {
    if (!('ref' in mention) || typeof mention.ref !== 'string') return null;
    if (mention.kind === DISCUSSION_ACCOUNT_MENTION_KIND) {
        const ref = parseMentionRefV1(mention.ref);
        const account = DiscussionAccountIdSchema.safeParse(ref?.scheme === DISCUSSION_ACCOUNT_MENTION_REF_SCHEME ? ref.opaque : null);
        return account.success ? { kind: 'account', accountId: account.data } : null;
    }
    if (mention.kind === MENTION_KIND_V1.session) {
        const session = SessionIdSchema.safeParse(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref));
        return session.success ? { kind: 'session', sessionId: session.data } : null;
    }
    if (mention.kind === DISCUSSION_MODEL_SLOT_MENTION_KIND) {
        const ref = parseMentionRefV1(mention.ref);
        const slot = DiscussionIdSchema.safeParse(ref?.scheme === DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME ? ref.opaque : null);
        return slot.success ? { kind: 'model', participantSlotId: slot.data } : null;
    }
    return null;
}

/** Resolves an optional manual title without adding a second UI limit owner. */
export function resolveDiscussionCreationTitle(input: Readonly<{
    title: string;
    text: string;
    mentions?: readonly ComposerStructuredInputMention[];
}>): string | null {
    const manualTitle = input.title.trim();
    if (manualTitle) return manualTitle.normalize('NFC');
    const references = parseComposerStructuredInputMentionsForText(input.mentions ?? [], input.text).mentions;
    const textWithoutResolvedMentions = [...references].reverse()
        .filter(mention => readDiscussionMentionParticipant(mention) !== null)
        .reduce((text, mention) => `${text.slice(0, mention.start)}${text.slice(mention.end)}`, input.text);
    const derived = textWithoutResolvedMentions
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0)
        ?.trim()
        .normalize('NFC');
    return derived || null;
}

export function projectDiscussionEntryParts(attachments: readonly PortableComposerAttachmentV1[] | undefined, viewerAccountId: string) {
    const parts: Extract<DiscussionTextMessageContentV1['parts'][number], { t: 'triage_entry' }>[] = [];
    for (const attachment of attachments ?? []) {
        const entry = readTriageEntryComposerAttachmentRefV1(attachment, viewerAccountId);
        if (!entry) return null;
        parts.push({ t: 'triage_entry', entry });
    }
    return parts;
}

export function buildDiscussionContent(
    text: string,
    mentions: readonly ComposerStructuredInputMention[],
    resolvedModelSessions?: ReadonlyMap<string, string>,
    attachments: readonly StoredAttachmentPayloadV1[] = [],
    entries: readonly Extract<DiscussionTextMessageContentV1['parts'][number], { t: 'triage_entry' }>[] = [],
): DiscussionTextMessageContentV1 {
    const parts: DiscussionTextMessageContentV1['parts'][number][] = [];
    let offset = 0;
    for (const mention of parseComposerStructuredInputMentionsForText(mentions, text).mentions) {
        const reference = readDiscussionMentionParticipant(mention);
        let participant: DiscussionParticipantRefV1 | null = null;
        if (reference?.kind === 'model') {
            const sessionId = resolvedModelSessions?.get(reference.participantSlotId);
            if (!sessionId) throw new Error('discussion_participant_start_required');
            participant = { kind: 'session', sessionId: SessionIdSchema.parse(sessionId) };
        } else if (reference) {
            participant = reference;
        }
        const selected = participant ? null : composerReferencesFromStructuredMentions({ text, mentions: [mention] })[0];
        if (!participant && !selected) continue;
        if (mention.start > offset) {
            parts.push({ t: 'text', text: text.slice(offset, mention.start).normalize('NFC') });
        }
        if (participant) parts.push({ t: 'mention', participant });
        else if (selected) {
            const { start: _start, end: _end, ...reference } = selected;
            parts.push({ t: 'reference', reference });
        }
        offset = mention.end;
    }
    if (offset < text.length) parts.push({ t: 'text', text: text.slice(offset).normalize('NFC') });
    parts.push(...attachments.map(attachment => ({ t: 'attachment' as const, attachment })));
    parts.push(...entries);
    return DiscussionTextMessageContentV1Schema.parse({ v: 1, parts });
}

export function buildDiscussionContentFromPendingText(input: Readonly<{
    previousText: string;
    pendingText: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): DiscussionTextMessageContentV1 {
    return buildDiscussionContent(input.pendingText, reconcileStructuredInputMentionsWithText({
        previousText: input.previousText,
        nextText: input.pendingText,
        mentions: parseComposerStructuredInputMentionsForText(input.mentions, input.previousText).mentions,
    }));
}
