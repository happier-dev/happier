import React from 'react';

import { DelegateOutputV1Schema } from '@happier-dev/protocol/messages/structured/delegateOutputV1';
import { PlanOutputV1Schema } from '@happier-dev/protocol/messages/structured/planOutputV1';
import { ReviewFindingsV1Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { ReviewFollowUpV1Schema } from '@happier-dev/protocol/messages/structured/reviewFollowUpV1';

import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { ReviewFollowUpMessageCard } from '@/components/sessions/reviews/messages/ReviewFollowUpMessageCard';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import {
    ExecutionRunResultLayout,
    type ExecutionRunResultPresentation,
} from '@/components/sessions/runs/ExecutionRunResultLayout';

export type ExecutionRunStructuredMetaEnvelope = Readonly<{
    kind: string;
    payload: unknown;
}>;

export function renderExecutionRunStructuredMeta(params: Readonly<{
    meta: ExecutionRunStructuredMetaEnvelope;
    sessionId: string;
    interaction: TranscriptInteraction;
    /** `page` when the result is the Run page itself (agents lab RP1); a transcript card otherwise. */
    presentation?: ExecutionRunResultPresentation;
    /** Page only: what closes the result's body (the Run's steps disclosure). */
    after?: React.ReactNode;
    /** The Run's server scope. */
    serverId?: string | null;
    /** Page only: the Run's display group, so a review started on several engines shows as one. */
    groupId?: string | null;
}>): React.ReactElement | null {
    const presentation = params.presentation ?? 'message';
    const kind = params.meta.kind;
    const payload = params.meta.payload;

    if (kind === 'review_findings.v1') {
        const parsed = ReviewFindingsV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return (
            <ReviewFindingsMessageCard
                payload={parsed.data}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
                presentation={presentation}
                after={params.after}
                serverId={params.serverId ?? null}
                groupId={params.groupId ?? null}
            />
        );
    }

    if (kind === 'review_findings.v2') {
        const parsed = ReviewFindingsV2Schema.safeParse(payload);
        if (!parsed.success) return null;
        return (
            <ReviewFindingsMessageCard
                payload={parsed.data}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
                presentation={presentation}
                after={params.after}
                serverId={params.serverId ?? null}
                groupId={params.groupId ?? null}
            />
        );
    }

    if (kind === 'review_follow_up.v1') {
        const parsed = ReviewFollowUpV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return presentation === 'page' ? (
            <ExecutionRunResultLayout presentation="page" after={params.after}>
                <ReviewFollowUpMessageCard payload={parsed.data} />
            </ExecutionRunResultLayout>
        ) : <ReviewFollowUpMessageCard payload={parsed.data} />;
    }

    if (kind === 'plan_output.v1') {
        const parsed = PlanOutputV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return (
            <PlanOutputMessageCard
                payload={parsed.data}
                sessionId={params.sessionId}
                canSendMessages={params.interaction.canSendMessages === true}
                presentation={presentation}
                after={params.after}
            />
        );
    }

    if (kind === 'delegate_output.v1') {
        const parsed = DelegateOutputV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return <DelegateOutputMessageCard payload={parsed.data} presentation={presentation} after={params.after} />;
    }

    return null;
}
