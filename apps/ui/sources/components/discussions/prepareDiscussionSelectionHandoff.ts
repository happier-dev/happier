import { omit } from 'zod/mini';
import { DiscussionSelectionSourceV1Schema, readDiscussionMessagePartsV1, type DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { isWorkflowDiscussionResultPublishableV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';

import { projectDiscussionMessageReferences, resolveDiscussionMessageSpeakerLabel, resolveDiscussionWorkflowAttribution } from './discussionTimelineProjection';
import { formatSelectedMessagesForClipboard } from '@/components/sessions/transcript/messageSelection/formatSelectedMessagesForClipboard';
import type { TranscriptBulkCopyFormat } from '@/components/sessions/transcript/messageSelection/_types';

type SendSelectionSource = Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;

export type SelectableDiscussionMessage = DiscussionOpenedMessageV1 & Readonly<{
    authorAccountId: string;
    content: NonNullable<DiscussionOpenedMessageV1['content']>;
}>;

function renderDiscussionContent(
    message: DiscussionOpenedMessageV1,
    resolveAccountLabel: (accountId: string) => string | null,
    resolveSessionLabel?: (sessionId: string) => string | null,
): string | null {
    if (!message.content) return null;
    for (const part of readDiscussionMessagePartsV1(message.content)) {
        if (part.t !== 'mention') continue;
        const label = (part.participant.kind === 'account'
            ? resolveAccountLabel(part.participant.accountId)
            : resolveSessionLabel?.(part.participant.sessionId))?.trim();
        if (!label) return null;
    }
    return projectDiscussionMessageReferences(message.content, {
        account: resolveAccountLabel, session: resolveSessionLabel,
    }).readableText;
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
    message: DiscussionOpenedMessageV1,
): message is SelectableDiscussionMessage {
    return message.authorAccountId !== null && message.content !== null;
}

/**
 * The answers each Workflow Run published into this thread, by Run, in thread order: what Save as pattern
 * starts from under a finished Run. A pass, a failure or a stop is an outcome rather than an answer, and
 * a message the thread cannot offer for selection is not one either.
 */
export function projectWorkflowRunPublishedAnswerIds(
    messages: ReadonlyArray<DiscussionOpenedMessageV1>,
): ReadonlyMap<string, readonly string[]> {
    const byRun = new Map<string, string[]>();
    const ordered = [...messages].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    for (const message of ordered) {
        const attribution = resolveDiscussionWorkflowAttribution(message);
        if (attribution?.outcome !== 'answer' || !isSelectableDiscussionMessage(message)) continue;
        const producer = message.producerV1;
        if (producer?.kind === 'workflow' && producer.execution.kind === 'action'
            && !isWorkflowDiscussionResultPublishableV1({ blockKind: 'action', lifecycle: 'completed', execution: producer.execution })) continue;
        byRun.set(attribution.runId, [...(byRun.get(attribution.runId) ?? []), message.id]);
    }
    return byRun;
}

/**
 * Adapts opened Discussion rows to the one neutral transcript-selection formatter.
 * It neither fetches content nor invents labels, authority, queueing, or draft state.
 */
export function prepareDiscussionSelectionHandoff(params: Readonly<{
    serverId: string;
    discussionId: string;
    selectedMessageIds: readonly string[];
    messages: readonly DiscussionOpenedMessageV1[];
    resolveAccountLabel: (accountId: string) => string | null;
    resolveSessionLabel?: (sessionId: string) => string | null;
    format: TranscriptBulkCopyFormat;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    /** The same `Via Agent` attribution the row renders, kept in the copied label. */
    agentAttributionLabel: string;
}>): Readonly<{ text: string; source: SendSelectionSource }> | null {
    const selected = new Set(params.selectedMessageIds);
    const entries: Array<Readonly<{ id: string; seq: number; role: 'user'; label: string; text: string }>> = [];
    for (const message of params.messages) {
        if (!selected.has(message.id) || !isSelectableDiscussionMessage(message)) continue;
        // Preserve the committed source instead of relabelling a stale row after
        // Home or Discussion navigation with the current destination's identity.
        if (message.messageRef.discussion.serverId !== params.serverId
            || message.messageRef.discussion.discussionId !== params.discussionId
            || message.discussionId !== params.discussionId) return null;
        const text = renderDiscussionContent(message, params.resolveAccountLabel, params.resolveSessionLabel);
        if (text === null) return null;
        const speaker = resolveDiscussionMessageSpeakerLabel(message, {
            account: (accountId) => params.resolveAccountLabel(accountId)?.trim() || null,
            session: (sessionId) => params.resolveSessionLabel?.(sessionId) ?? null,
            workflowRun: () => null,
        });
        const label = message.producerV1?.kind === 'agent'
            ? `${speaker} · ${params.agentAttributionLabel}`
            : speaker;
        entries.push({ id: message.id, seq: message.seq, role: 'user', label, text });
    }
    entries.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    if (entries.length === 0) return null;

    const source = omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true }).parse({
        kind: 'discussion',
        serverId: params.serverId,
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
