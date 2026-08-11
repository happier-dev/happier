import React from 'react';
import type { ZodSchema } from 'zod';

import { ReviewCommentsV1Schema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { ReviewCommentsMessageCard } from '@/components/sessions/reviews/messages/ReviewCommentsMessageCard';
import {
    DelegateOutputV1Schema,
    PlanOutputV1Schema,
    ParticipantMessageV1Schema,
    ReviewFindingsV1Schema,
    ReviewFindingsV2Schema,
    ReviewFollowUpV1Schema,
    SessionSummaryShardV1Schema,
    SessionSynopsisV1Schema,
    SubagentCommandV1Schema,
    SubagentLaunchV1Schema,
    VoiceAgentTurnV1Schema,
} from '@happier-dev/protocol';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { ReviewFollowUpMessageCard } from '@/components/sessions/reviews/messages/ReviewFollowUpMessageCard';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { readStructuredUserMessageText } from '@/components/sessions/transcript/structured/readStructuredUserMessageText';
import { ParticipantMessageCard } from '@/components/sessions/participants/messages/ParticipantMessageCard';
import { SubagentLaunchMessageCard } from '@/components/sessions/subagents/messages/SubagentLaunchMessageCard';
import { SubagentCommandMessageCard } from '@/components/sessions/subagents/messages/SubagentCommandMessageCard';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export type StructuredMessageKind =
    | 'participant_message.v1'
    | 'subagent_launch.v1'
    | 'subagent_command.v1'
    | 'review_comments.v1'
    | 'review_findings.v1'
    | 'review_findings.v2'
    | 'review_follow_up.v1'
    | 'plan_output.v1'
    | 'delegate_output.v1'
    | 'voice_agent_turn.v1'
    | 'session_synopsis.v1'
    | 'session_summary_shard.v1';

export type StructuredMessageRendererParams = Readonly<{
    sessionId: string;
    /**
     * The transcript message the envelope arrived on, when there is one.
     *
     * Optional because the same envelopes also reach these renderers from the execution-run
     * registry (`sessionExecutionRunGet(..., { includeStructured: true })`), where no message
     * exists. Only the kinds that quote the user's own text need it, and they already render
     * nothing when there is no text to quote.
     */
    message?: Message;
    interaction: TranscriptInteraction;
    onJumpToAnchor?: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}>;

export type StructuredMessageRegistryEntry<T> = Readonly<{
    kind: StructuredMessageKind;
    schema: ZodSchema<T>;
    render: (payload: T, params: StructuredMessageRendererParams) => React.ReactElement | null;
}>;

// A structured card that quotes the message body only exists when the message carries one
// (a `subagent_launch.v1` envelope can ride a tool call, which has no user text). Callers read
// `renderStructuredMessage(...) != null` to decide whether the structured card *replaces* the
// surrounding chrome, so that emptiness has to be decided here, before an element exists — a
// card that returns null from its own body still yields a non-null element and would suppress
// the chrome in favour of a row that paints nothing.
function renderUserTextStructuredCard(
    params: StructuredMessageRendererParams,
    renderCard: (messageText: string) => React.ReactElement,
): React.ReactElement | null {
    const messageText = params.message ? readStructuredUserMessageText(params.message) : null;
    if (!messageText) return null;
    return renderCard(messageText);
}

const structuredMessageRegistryEntries: readonly StructuredMessageRegistryEntry<any>[] = [
    {
        kind: 'participant_message.v1',
        schema: ParticipantMessageV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <ParticipantMessageCard payload={payload} messageText={messageText} />
        )),
    },
    {
        kind: 'subagent_launch.v1',
        schema: SubagentLaunchV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <SubagentLaunchMessageCard payload={payload} messageText={messageText} />
        )),
    },
    {
        kind: 'subagent_command.v1',
        schema: SubagentCommandV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <SubagentCommandMessageCard payload={payload} messageText={messageText} />
        )),
    },
    {
        kind: 'review_comments.v1',
        schema: ReviewCommentsV1Schema,
        render: (payload, params) => (
            <ReviewCommentsMessageCard payload={payload} onJumpToAnchor={params.onJumpToAnchor} />
        ),
    },
    {
        kind: 'review_findings.v1',
        schema: ReviewFindingsV1Schema,
        render: (payload, params) => (
            <ReviewFindingsMessageCard
                payload={payload}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
            />
        ),
    },
    {
        kind: 'review_findings.v2',
        schema: ReviewFindingsV2Schema,
        render: (payload, params) => (
            <ReviewFindingsMessageCard
                payload={payload}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
            />
        ),
    },
    {
        kind: 'review_follow_up.v1',
        schema: ReviewFollowUpV1Schema,
        render: (payload) => <ReviewFollowUpMessageCard payload={payload} />,
    },
    {
        kind: 'plan_output.v1',
        schema: PlanOutputV1Schema,
        render: (payload, params) => (
            <PlanOutputMessageCard
                payload={payload}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
            />
        ),
    },
    {
        kind: 'delegate_output.v1',
        schema: DelegateOutputV1Schema,
        render: (payload) => (
            <DelegateOutputMessageCard payload={payload} />
        ),
    },
    {
        kind: 'voice_agent_turn.v1',
        schema: VoiceAgentTurnV1Schema,
        // Voice turns are rendered in the voice sidebar; the transcript registry should still validate the payload.
        render: () => null,
    },
    {
        kind: 'session_synopsis.v1',
        schema: SessionSynopsisV1Schema,
        render: () => null,
    },
    {
        kind: 'session_summary_shard.v1',
        schema: SessionSummaryShardV1Schema,
        render: () => null,
    },
];

// Avoid freezing an inline literal: it forces TS to infer a huge union of anonymous object types.
export const STRUCTURED_MESSAGE_REGISTRY: readonly StructuredMessageRegistryEntry<any>[] =
    Object.freeze(structuredMessageRegistryEntries);

export function findStructuredMessageRenderer(kind: string): StructuredMessageRegistryEntry<any> | null {
    for (const entry of STRUCTURED_MESSAGE_REGISTRY) {
        if (entry.kind === kind) return entry;
    }
    return null;
}
