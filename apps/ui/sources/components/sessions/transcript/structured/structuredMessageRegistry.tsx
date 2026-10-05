import React from 'react';
import { t } from '@/text';

import { ReviewCommentsV1Schema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { ReviewCommentsMessageCard, projectReviewCommentsFindText } from '@/components/sessions/reviews/messages/ReviewCommentsMessageCard';
import {
    DelegateOutputV1Schema,
    ExecutionRunCompletionV1Schema,
    type ExecutionRunCompletionV1,
    type WorkerUpdateV1,
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
import { ReviewFindingsMessageCard, projectReviewFindingsFindText } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { ReviewFollowUpMessageCard, projectReviewFollowUpFindText } from '@/components/sessions/reviews/messages/ReviewFollowUpMessageCard';
import { PlanOutputMessageCard, projectPlanOutputFindText } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard, projectDelegateOutputFindText } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import type { Message } from "@happier-dev/session-core/messages";
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { readStructuredUserMessageText } from '@/components/sessions/transcript/structured/readStructuredUserMessageText';
import { ParticipantMessageCard, projectParticipantMessageFindText } from '@/components/sessions/participants/messages/ParticipantMessageCard';
import { SubagentLaunchMessageCard, projectSubagentLaunchFindText } from '@/components/sessions/subagents/messages/SubagentLaunchMessageCard';
import { SubagentCommandMessageCard, projectSubagentCommandFindText } from '@/components/sessions/subagents/messages/SubagentCommandMessageCard';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { WorkerUpdateCard, projectWorkerUpdateFindText } from '@/components/sessions/work/WorkerUpdateCard';
import { VoiceTranscriptNotePayloadSchema } from '@/voice/transcript/voiceTranscriptNoteMeta';
import { resolveVoiceContinuationNoteText } from '@/voice/transcript/voiceTranscriptNotePresentation';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { StructuredFindText, type StructuredFindTextBlock, type StructuredFindProjectionContext } from './structuredFindText';

export type StructuredMessageKind =
    | 'voice_note.v1'
    | 'participant_message.v1'
    | 'subagent_launch.v1'
    | 'subagent_command.v1'
    | 'review_comments.v1'
    | 'review_findings.v1'
    | 'review_findings.v2'
    | 'review_follow_up.v1'
    | 'plan_output.v1'
    | 'delegate_output.v1'
    | 'execution_run_completion.v1'
    | 'voice_agent_turn.v1'
    | 'session_synopsis.v1'
    | 'session_summary_shard.v1';

export type StructuredMessageRendererParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    message: Message;
    interaction: TranscriptInteraction;
    onJumpToAnchor?: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}>;

export type StructuredMessageSafeParseResult<T> =
    | Readonly<{ success: true; data: T }>
    | Readonly<{ success: false; error: unknown }>;

export type StructuredMessageSchema<T> = Readonly<{
    safeParse: (value: unknown) => StructuredMessageSafeParseResult<T>;
}>;

export type StructuredMessageRegistryEntry<T> = Readonly<{
    kind: string;
    schema: StructuredMessageSchema<T>;
    render: (payload: T, params: StructuredMessageRendererParams) => React.ReactElement | null;
    projectFindText: (payload: T, params: StructuredFindProjectionContext & Readonly<{ message: Message }>) => readonly StructuredFindTextBlock[] | null;
    reviewRunIds?: (payload: T) => readonly string[];
    usesSessionMessages?: true;
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
    const messageText = readStructuredUserMessageText(params.message);
    if (!messageText) return null;
    return renderCard(messageText);
}

function legacyCompletionUpdate(payload: ExecutionRunCompletionV1, sessionId: string): WorkerUpdateV1 {
    return {
        v: 1, workerKind: 'execution_run', workerId: payload.runId, ownerState: payload.status,
        wake: 'finished', headline: t('executionRuns.details.titles.executionRun'),
        result: payload.summary ?? '', canInspect: payload.canInspect,
        transcriptPointer: { kind: 'execution_run', sessionId, runId: payload.runId },
    };
}

const structuredMessageRegistryEntries: readonly StructuredMessageRegistryEntry<any>[] = [
    {
        kind: 'voice_note.v1',
        schema: VoiceTranscriptNotePayloadSchema,
        render: (_payload, params) => params.message.kind === 'agent-text'
            ? <StructuredFindText blockId="structured-voice-note" style={transcriptMarkdownTextStyle} text={resolveVoiceContinuationNoteText(params.message.meta) ?? params.message.text} />
            : null,
        projectFindText: (_payload, params) => params.message.kind === 'agent-text'
            ? [{ id: 'structured-voice-note', text: resolveVoiceContinuationNoteText(params.message.meta) ?? params.message.text }]
            : null,
    },
    {
        kind: 'participant_message.v1',
        schema: ParticipantMessageV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <ParticipantMessageCard payload={payload} messageText={messageText} />
        )),
        projectFindText: (payload, params) => {
            const text = readStructuredUserMessageText(params.message);
            return text ? projectParticipantMessageFindText(payload, text) : null;
        },
    },
    {
        kind: 'subagent_launch.v1',
        schema: SubagentLaunchV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <SubagentLaunchMessageCard payload={payload} messageText={messageText} />
        )),
        projectFindText: (payload, params) => {
            const text = readStructuredUserMessageText(params.message);
            return text ? projectSubagentLaunchFindText(payload, text) : null;
        },
    },
    {
        kind: 'subagent_command.v1',
        schema: SubagentCommandV1Schema,
        render: (payload, params) => renderUserTextStructuredCard(params, (messageText) => (
            <SubagentCommandMessageCard payload={payload} messageText={messageText} />
        )),
        projectFindText: (payload, params) => {
            const text = readStructuredUserMessageText(params.message);
            return text ? projectSubagentCommandFindText(payload, text) : null;
        },
    },
    {
        kind: 'review_comments.v1',
        schema: ReviewCommentsV1Schema,
        render: (payload, params) => (
            <ReviewCommentsMessageCard payload={payload} onJumpToAnchor={params.onJumpToAnchor} />
        ),
        projectFindText: (payload, params) => projectReviewCommentsFindText(payload, { canJumpToAnchor: params.canJumpToAnchor }),
    },
    {
        kind: 'review_findings.v1',
        schema: ReviewFindingsV1Schema,
        render: (payload, params) => (
            <ReviewFindingsMessageCard
                payload={payload}
                sessionId={params.sessionId}
                serverId={params.serverId}
                canSendMessages={params.interaction.canSendMessages === true}
            />
        ),
        projectFindText: (payload, params) => projectReviewFindingsFindText(payload, { ...params, reviewComments: params.readReviewComments?.(payload.runRef.runId) }),
        reviewRunIds: (payload) => [payload.runRef.runId],
        usesSessionMessages: true,
    },
    {
        kind: 'review_findings.v2',
        schema: ReviewFindingsV2Schema,
        render: (payload, params) => (
            <ReviewFindingsMessageCard
                payload={payload}
                sessionId={params.sessionId}
                serverId={params.serverId}
                canSendMessages={params.interaction.canSendMessages === true}
            />
        ),
        projectFindText: (payload, params) => projectReviewFindingsFindText(payload, { ...params, reviewComments: params.readReviewComments?.(payload.runRef.runId) }),
        reviewRunIds: (payload) => [payload.runRef.runId],
        usesSessionMessages: true,
    },
    {
        kind: 'review_follow_up.v1',
        schema: ReviewFollowUpV1Schema,
        render: (payload) => <ReviewFollowUpMessageCard payload={payload} />,
        projectFindText: (payload) => projectReviewFollowUpFindText(payload),
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
        projectFindText: (payload, params) => projectPlanOutputFindText(payload, { canSendMessages: params.canSendMessages }),
    },
    {
        kind: 'delegate_output.v1',
        schema: DelegateOutputV1Schema,
        render: (payload) => (
            <DelegateOutputMessageCard payload={payload} />
        ),
        projectFindText: (payload) => projectDelegateOutputFindText(payload),
    },
    {
        kind: 'execution_run_completion.v1',
        schema: ExecutionRunCompletionV1Schema,
        // Retained 0.2 rows have no effective-engine fact; do not infer one from the current lead.
        render: (payload, params) => <WorkerUpdateCard update={legacyCompletionUpdate(payload, params.sessionId)} serverId={params.serverId} navigationEnabled={params.interaction.permissionDisabledReason !== 'public'} />,
        projectFindText: (payload, params) => projectWorkerUpdateFindText(legacyCompletionUpdate(payload, params.sessionId ?? ''), { canInspect: payload.canInspect && params.canNavigate === true }),
    },
    {
        kind: 'voice_agent_turn.v1',
        schema: VoiceAgentTurnV1Schema,
        // Voice turns are rendered in the voice sidebar; the transcript registry should still validate the payload.
        render: () => null,
        projectFindText: () => null,
    },
    {
        kind: 'session_synopsis.v1',
        schema: SessionSynopsisV1Schema,
        render: () => null,
        projectFindText: () => null,
    },
    {
        kind: 'session_summary_shard.v1',
        schema: SessionSummaryShardV1Schema,
        render: () => null,
        projectFindText: () => null,
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
