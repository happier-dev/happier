import React from 'react';

import {
    DelegateOutputV1Schema,
    PlanOutputV1Schema,
    ReviewFindingsV1Schema,
} from '@happier-dev/protocol';

import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { PlanOutputMessageCard } from '@/components/sessions/plans/messages/PlanOutputMessageCard';
import { DelegateOutputMessageCard } from '@/components/sessions/delegations/messages/DelegateOutputMessageCard';

export type ExecutionRunStructuredMetaEnvelope = Readonly<{
    kind: string;
    payload: unknown;
}>;

export function renderExecutionRunStructuredMeta(params: Readonly<{
    meta: ExecutionRunStructuredMetaEnvelope;
    sessionId: string;
}>): React.ReactElement | null {
    const kind = params.meta.kind;
    const payload = params.meta.payload;

    if (kind === 'review_findings.v1') {
        const parsed = ReviewFindingsV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return <ReviewFindingsMessageCard payload={parsed.data} sessionId={params.sessionId} />;
    }

    if (kind === 'plan_output.v1') {
        const parsed = PlanOutputV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return <PlanOutputMessageCard payload={parsed.data} sessionId={params.sessionId} />;
    }

    if (kind === 'delegate_output.v1') {
        const parsed = DelegateOutputV1Schema.safeParse(payload);
        if (!parsed.success) return null;
        return <DelegateOutputMessageCard payload={parsed.data} />;
    }

    return null;
}

