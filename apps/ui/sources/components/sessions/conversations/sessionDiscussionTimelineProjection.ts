import { SessionDiscussionSelectionSourceV1Schema } from '@happier-dev/protocol/sessions/discussions/content';
import type { SessionDiscussionOpenedMessageV1 } from '@happier-dev/protocol/sessions/discussions/actions';

import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export type SessionDiscussionTimelineMessage = Pick<SessionDiscussionOpenedMessageV1, 'id' | 'seq'>;

export type SessionDiscussionTimelineItem<
    TMessage extends SessionDiscussionTimelineMessage = SessionDiscussionOpenedMessageV1,
> =
    | Readonly<{
        kind: 'human_message';
        message: TMessage;
    }>
    | Readonly<{
        kind: 'agent_activity_reference';
        anchorSeq: number;
        entry: AgentActivityEntry;
        subagent: SessionSubagent;
    }>;

type AgentActivityReference = Extract<SessionDiscussionTimelineItem, { kind: 'agent_activity_reference' }>;

function compareReferences(left: AgentActivityReference, right: AgentActivityReference): number {
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
export function buildSessionDiscussionTimelineItems<TMessage extends SessionDiscussionTimelineMessage>(params: Readonly<{
    sessionId: string;
    discussionId: string;
    messages: readonly TMessage[];
    subagents: readonly SessionSubagent[];
    readExecutionRunEntry: (runId: string) => AgentActivityEntry | null;
}>): readonly SessionDiscussionTimelineItem<TMessage>[] {
    const messageById = new Map(params.messages.map((message) => [message.id, message]));
    const referencesByAnchorSeq = new Map<number, AgentActivityReference[]>();

    for (const subagent of params.subagents) {
        if (subagent.kind !== 'execution_run') continue;
        const runId = subagent.runRef?.runId;
        if (!runId) continue;

        const sourceResult = SessionDiscussionSelectionSourceV1Schema.safeParse(subagent.runRef?.launchOrigin);
        if (!sourceResult.success) continue;
        const source = sourceResult.data;
        if (source.sessionId !== params.sessionId || source.discussionId !== params.discussionId) continue;

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
        if (!entry || entry.kind !== 'execution_run' || entry.runId !== runId) continue;
        const reference: AgentActivityReference = {
            kind: 'agent_activity_reference',
            anchorSeq,
            entry,
            subagent,
        };
        const atAnchor = referencesByAnchorSeq.get(anchorSeq);
        if (atAnchor) atAnchor.push(reference);
        else referencesByAnchorSeq.set(anchorSeq, [reference]);
    }

    for (const references of referencesByAnchorSeq.values()) references.sort(compareReferences);

    const items: SessionDiscussionTimelineItem<TMessage>[] = [];
    for (const message of params.messages) {
        items.push({ kind: 'human_message', message });
        items.push(...(referencesByAnchorSeq.get(message.seq) ?? []));
    }
    return items;
}

/**
 * The canonical rows a reader has actually been shown as readable content.
 *
 * A visible row whose content the Session cipher could not open is an
 * unavailable placeholder, not something read. The private cursor is one
 * monotone sequence, so a later readable row must not carry it past an earlier
 * unread unreadable one: only rows before the first retained unreadable row
 * above the confirmed cursor qualify. An unreadable row the cursor already
 * covers was read before and blocks nothing. Optimistic or unknown rows are
 * never in `messages` and never qualify.
 */
export function resolveReadableVisibleDiscussionSeqs(input: Readonly<{
    messages: readonly Pick<SessionDiscussionOpenedMessageV1, 'id' | 'seq' | 'content'>[];
    visibleMessageIds: ReadonlySet<string>;
    /** The confirmed private read cursor, or null when this viewer has none. */
    lastReadSeq: number | null;
}>): readonly number[] {
    const seqs: number[] = [];
    for (const message of input.messages) {
        if (message.content === null) {
            if (input.lastReadSeq !== null && message.seq <= input.lastReadSeq) continue;
            break;
        }
        if (input.visibleMessageIds.has(message.id)) seqs.push(message.seq);
    }
    return seqs;
}
