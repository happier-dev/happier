import {
    SessionDiscussionAccountIdSchema,
    type SessionDiscussionMessageContentV1,
} from '@happier-dev/protocol/sessions/discussions/content';

import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';

export type DiscussionMentionSpan = Readonly<{
    start: number;
    end: number;
    accountId: string;
}>;

/** Resolves an optional manual title without adding a second UI limit owner. */
export function resolveSessionDiscussionCreationTitle(input: Readonly<{
    title: string;
    text: string;
    mentions?: readonly DiscussionMentionSpan[];
}>): string | null {
    const manualTitle = input.title.trim();
    if (manualTitle) return manualTitle.normalize('NFC');
    const textWithoutResolvedMentions = [...(input.mentions ?? [])]
        .sort((left, right) => right.start - left.start)
        .reduce((text, mention) => (
            mention.start >= 0 && mention.end > mention.start && mention.end <= text.length
                ? `${text.slice(0, mention.start)}${text.slice(mention.end)}`
                : text
        ), input.text);
    const derived = textWithoutResolvedMentions
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0)
        ?.trim()
        .normalize('NFC');
    return derived || null;
}

/**
 * Opens the human draft's intentionally JSON-shaped mention field into the one
 * composer representation. Invalid or overlapping spans remain ordinary text;
 * they never manufacture an Account identity from a visible `@label`.
 */
export function parseDiscussionMentionSpans(
    value: unknown,
    text: string,
): readonly DiscussionMentionSpan[] {
    if (!Array.isArray(value)) return [];
    const candidates = value.flatMap((entry): readonly DiscussionMentionSpan[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        if (Object.keys(entry).sort().join(',') !== 'accountId,end,start') return [];
        const candidate = entry as Record<string, unknown>;
        const accountId = SessionDiscussionAccountIdSchema.safeParse(candidate.accountId);
        if (
            !accountId.success
            || !Number.isSafeInteger(candidate.start)
            || !Number.isSafeInteger(candidate.end)
        ) return [];
        const start = candidate.start as number;
        const end = candidate.end as number;
        if (start < 0 || end <= start || end > text.length) return [];
        const visible = text.slice(start, end);
        const before = text.slice(Math.max(0, start - 1), start);
        const after = text.slice(end, end + 1);
        if (
            !visible.startsWith('@')
            || visible.length === 1
            || (start > 0 && !/\s/u.test(before))
            || /[\p{L}\p{N}_]/u.test(after)
        ) return [];
        return [{ start, end, accountId: accountId.data }];
    }).sort((left, right) => left.start - right.start || left.end - right.end);

    let greatestPreviousEnd = -1;
    return candidates.filter((candidate, index) => {
        const overlapsPrevious = greatestPreviousEnd > candidate.start;
        greatestPreviousEnd = Math.max(greatestPreviousEnd, candidate.end);
        const overlapsNext = (candidates[index + 1]?.start ?? Number.POSITIVE_INFINITY) < candidate.end;
        // An ambiguous range is not resolved by array order. Every conflicting
        // entry remains plain text instead of choosing an Account identity.
        return !overlapsPrevious && !overlapsNext;
    });
}

function readChangedRange(previousText: string, nextText: string): Readonly<{
    previousStart: number;
    previousEnd: number;
    delta: number;
}> {
    const sharedLength = Math.min(previousText.length, nextText.length);
    let prefixLength = 0;
    while (
        prefixLength < sharedLength
        && previousText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)
    ) {
        prefixLength += 1;
    }

    let suffixLength = 0;
    while (
        suffixLength < sharedLength - prefixLength
        && previousText.charCodeAt(previousText.length - suffixLength - 1)
            === nextText.charCodeAt(nextText.length - suffixLength - 1)
    ) {
        suffixLength += 1;
    }

    return {
        previousStart: prefixLength,
        previousEnd: previousText.length - suffixLength,
        delta: nextText.length - previousText.length,
    };
}

/**
 * Keeps selected Account identity attached only while its complete visible
 * token survives an edit. This is a document transform, not cursor policy:
 * every UI host (native/web and synchronized draft replay) gets identical
 * mention behavior without trusting a freshly typed `@label` as identity.
 */
export function reconcileDiscussionMentionSpans(params: Readonly<{
    previousText: string;
    nextText: string;
    mentions: readonly DiscussionMentionSpan[];
}>): readonly DiscussionMentionSpan[] {
    if (params.previousText === params.nextText) return params.mentions;
    const change = readChangedRange(params.previousText, params.nextText);

    return params.mentions.flatMap((mention) => {
        const preserve = (candidate: DiscussionMentionSpan): readonly DiscussionMentionSpan[] => {
            const previousToken = params.previousText.slice(mention.start, mention.end);
            if (params.nextText.slice(candidate.start, candidate.end) !== previousToken) return [];
            const before = params.nextText.slice(Math.max(0, candidate.start - 1), candidate.start);
            const after = params.nextText.slice(candidate.end, candidate.end + 1);
            if ((candidate.start > 0 && !/\s/u.test(before)) || /[\p{L}\p{N}_]/u.test(after)) return [];
            return [candidate];
        };
        if (mention.end <= change.previousStart) return preserve(mention);
        if (mention.start >= change.previousEnd) {
            return preserve({
                ...mention,
                start: mention.start + change.delta,
                end: mention.end + change.delta,
            });
        }
        return [];
    });
}

export function buildSessionDiscussionContent(
    text: string,
    mentions: readonly DiscussionMentionSpan[],
): SessionDiscussionMessageContentV1 {
    const parts: SessionDiscussionMessageContentV1['parts'][number][] = [];
    let offset = 0;
    for (const mention of [...mentions].sort((left, right) => left.start - right.start)) {
        if (
            mention.start < offset
            || mention.end <= mention.start
            || mention.end > text.length
        ) {
            continue;
        }
        if (mention.start > offset) {
            parts.push({ t: 'text', text: text.slice(offset, mention.start).normalize('NFC') });
        }
        parts.push({ t: 'mention', accountId: mention.accountId });
        offset = mention.end;
    }
    if (offset < text.length) parts.push({ t: 'text', text: text.slice(offset).normalize('NFC') });
    return { v: 1, parts };
}

export function buildSessionDiscussionContentFromPendingText(input: Readonly<{
    previousText: string;
    pendingText: string;
    mentions: readonly DiscussionMentionSpan[];
}>): SessionDiscussionMessageContentV1 {
    return buildSessionDiscussionContent(input.pendingText, reconcileDiscussionMentionSpans({
        previousText: input.previousText,
        nextText: input.pendingText,
        mentions: input.mentions,
    }));
}

/**
 * An Account mention inside the one composer (`AgentInput`). It is the discussion's own reference:
 * the `accountMention` suggestion kind produces it and only this adapter reads it back, as the
 * `{ start, end, accountId }` span the draft stores and the `mention` part the wire carries. It is
 * never an agent message reference (no `MentionRefV1` kind), so it never leaves the discussion.
 */
export const DISCUSSION_ACCOUNT_MENTION_KIND = 'happier.account';
const DISCUSSION_ACCOUNT_MENTION_REF_PREFIX = 'account:';

/** What the `accountMention` kind hands the composer; the composer adds the token and its range. */
export function buildDiscussionAccountMentionPayload(accountId: string, label: string): Readonly<{
    kind: string;
    ref: string;
    label: string;
}> {
    return { kind: DISCUSSION_ACCOUNT_MENTION_KIND, ref: `${DISCUSSION_ACCOUNT_MENTION_REF_PREFIX}${accountId}`, label };
}

/** The draft's spans as the composer's mentions, each bound to the visible token it covers. */
export function discussionComposerMentionsFromSpans(
    text: string,
    spans: readonly DiscussionMentionSpan[],
): ComposerStructuredInputMention[] {
    return spans.map((span) => ({
        kind: DISCUSSION_ACCOUNT_MENTION_KIND,
        ref: `${DISCUSSION_ACCOUNT_MENTION_REF_PREFIX}${span.accountId}`,
        tokenText: text.slice(span.start, span.end),
        start: span.start,
        end: span.end,
    }));
}

/**
 * The composer's Account mentions as draft spans. Any other kind, and an Account reference that
 * does not carry a valid Account id, stays ordinary text: identity is never inferred.
 */
export function discussionMentionSpansFromComposerMentions(
    mentions: readonly ComposerStructuredInputMention[],
): DiscussionMentionSpan[] {
    return mentions.flatMap((mention): DiscussionMentionSpan[] => {
        if (mention.kind !== DISCUSSION_ACCOUNT_MENTION_KIND || !('ref' in mention) || typeof mention.ref !== 'string') return [];
        if (!mention.ref.startsWith(DISCUSSION_ACCOUNT_MENTION_REF_PREFIX)) return [];
        const accountId = SessionDiscussionAccountIdSchema.safeParse(mention.ref.slice(DISCUSSION_ACCOUNT_MENTION_REF_PREFIX.length));
        return accountId.success ? [{ start: mention.start, end: mention.end, accountId: accountId.data }] : [];
    });
}
