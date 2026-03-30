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
import { ParticipantMessageCard } from '@/components/sessions/participants/messages/ParticipantMessageCard';
import { SubagentLaunchMessageCard } from '@/components/sessions/subagents/messages/SubagentLaunchMessageCard';
import { SubagentCommandMessageCard } from '@/components/sessions/subagents/messages/SubagentCommandMessageCard';

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
    message: Message;
    onJumpToAnchor: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}>;

export type StructuredMessageRegistryEntry<T> = Readonly<{
    kind: StructuredMessageKind;
    schema: ZodSchema<T>;
    render: (payload: T, params: StructuredMessageRendererParams) => React.ReactElement | null;
}>;

const structuredMessageRegistryEntries: readonly StructuredMessageRegistryEntry<any>[] = [
    {
        kind: 'participant_message.v1',
        schema: ParticipantMessageV1Schema,
        render: (payload, params) => <ParticipantMessageCard payload={payload} message={params.message} />,
    },
    {
        kind: 'subagent_launch.v1',
        schema: SubagentLaunchV1Schema,
        render: (payload, params) => <SubagentLaunchMessageCard payload={payload} message={params.message} />,
    },
    {
        kind: 'subagent_command.v1',
        schema: SubagentCommandV1Schema,
        render: (payload, params) => <SubagentCommandMessageCard payload={payload} message={params.message} />,
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
            <ReviewFindingsMessageCard payload={payload} sessionId={params.sessionId} />
        ),
    },
    {
        kind: 'review_findings.v2',
        schema: ReviewFindingsV2Schema,
        render: (payload, params) => (
            <ReviewFindingsMessageCard payload={payload} sessionId={params.sessionId} />
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
            <PlanOutputMessageCard payload={payload} sessionId={params.sessionId} />
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
