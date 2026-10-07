import { SessionDiscussionSelectionSourceV1Schema, type SessionDiscussionSelectionSourceV1 } from '@happier-dev/protocol/sessions/discussions/content';
import type { SessionDiscussionOpenedMessageV1 } from '@happier-dev/protocol/sessions/discussions/actions';

import { formatSelectedMessagesForClipboard } from '@/components/sessions/transcript/messageSelection/formatSelectedMessagesForClipboard';
import type { TranscriptBulkCopyFormat } from '@/components/sessions/transcript/messageSelection/_types';

type SendSelectionSource = Omit<SessionDiscussionSelectionSourceV1, 'draftCorrelationId'>;

export type SelectableDiscussionMessage = SessionDiscussionOpenedMessageV1 & Readonly<{
    authorAccountId: string;
    content: NonNullable<SessionDiscussionOpenedMessageV1['content']>;
}>;

function renderDiscussionContent(
    message: SessionDiscussionOpenedMessageV1,
    resolveAccountLabel: (accountId: string) => string | null,
): string | null {
    if (!message.content) return null;
    const parts: string[] = [];
    for (const part of message.content.parts) {
        if (part.t === 'text') {
            parts.push(part.text);
            continue;
        }
        const label = resolveAccountLabel(part.accountId)?.trim();
        if (!label) return null;
        parts.push(`@${label}`);
    }
    return parts.join('');
}

/**
 * The one eligibility decision for Discussion message selection: a row is
 * selectable when it carries a canonical Account author and opened content.
 *
 * Agent provenance is attribution, not exclusion — an Agent-posted row is a
 * collaborator's message the Session's Agent wrote on their behalf, and the
 * user can Copy, Ask Agent and Send to Session with it like any other row. The
 * eligible-row list, the per-row affordance and this formatter consume this
 * same predicate so one surface can never offer a row another one drops.
 */
export function isSelectableDiscussionMessage(
    message: SessionDiscussionOpenedMessageV1,
): message is SelectableDiscussionMessage {
    return message.authorAccountId !== null && message.content !== null;
}

/**
 * Adapts opened Discussion rows to the one neutral transcript-selection formatter.
 * It neither fetches content nor invents labels, authority, queueing, or draft state.
 */
export function prepareDiscussionSelectionHandoff(params: Readonly<{
    sessionId: string;
    discussionId: string;
    selectedMessageIds: readonly string[];
    messages: readonly SessionDiscussionOpenedMessageV1[];
    resolveAccountLabel: (accountId: string) => string | null;
    format: TranscriptBulkCopyFormat;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    /** The same `Via Agent` attribution the row renders, kept in the copied label. */
    agentAttributionLabel: string;
}>): Readonly<{ text: string; source: SendSelectionSource }> | null {
    const selected = new Set(params.selectedMessageIds);
    const entries: Array<Readonly<{ id: string; seq: number; role: 'user'; label: string; text: string }>> = [];
    for (const message of params.messages) {
        if (!selected.has(message.id) || !isSelectableDiscussionMessage(message)) continue;
        const accountLabel = params.resolveAccountLabel(message.authorAccountId)?.trim();
        const text = renderDiscussionContent(message, params.resolveAccountLabel);
        if (!accountLabel || text === null) return null;
        const label = message.producerV1 === null
            ? accountLabel
            : `${accountLabel} · ${params.agentAttributionLabel}`;
        entries.push({ id: message.id, seq: message.seq, role: 'user', label, text });
    }
    entries.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    if (entries.length === 0) return null;

    const source = SessionDiscussionSelectionSourceV1Schema.omit({ draftCorrelationId: true }).parse({
        kind: 'session_discussion',
        sessionId: params.sessionId,
        discussionId: params.discussionId,
        messageIds: entries.map((entry) => entry.id),
    });
    return {
        text: formatSelectedMessagesForClipboard(entries, {
            format: params.format,
            roleLabels: params.roleLabels,
        }),
        source,
    };
}
