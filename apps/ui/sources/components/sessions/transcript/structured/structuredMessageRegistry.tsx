import React from 'react';
import type { ZodSchema } from 'zod';

import { ReviewCommentsV1Schema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { ReviewCommentsMessageCard } from '@/components/sessions/reviews/messages/ReviewCommentsMessageCard';
import { DelegateOutputV1Schema, PlanOutputV1Schema, ReviewFindingsV1Schema, VoiceAgentTurnV1Schema } from '@happier-dev/protocol';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export type StructuredMessageKind =
    | 'review_comments.v1'
    | 'review_findings.v1'
    | 'plan_output.v1'
    | 'delegate_output.v1'
    | 'voice_agent_turn.v1';

export type StructuredMessageRendererParams = Readonly<{
    sessionId: string;
    onJumpToAnchor: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}>;

export type StructuredMessageRegistryEntry<T> = Readonly<{
    kind: StructuredMessageKind;
    schema: ZodSchema<T>;
    render: (payload: T, params: StructuredMessageRendererParams) => React.ReactElement | null;
}>;

export const STRUCTURED_MESSAGE_REGISTRY: readonly StructuredMessageRegistryEntry<any>[] = Object.freeze([
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
]);

export function findStructuredMessageRenderer(kind: string): StructuredMessageRegistryEntry<any> | null {
    for (const entry of STRUCTURED_MESSAGE_REGISTRY) {
        if (entry.kind === kind) return entry;
    }
    return null;
}
