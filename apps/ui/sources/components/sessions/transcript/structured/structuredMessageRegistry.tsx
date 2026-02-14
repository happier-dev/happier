import React from 'react';
import type { ZodSchema } from 'zod';

import { ReviewCommentsV1Schema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { ReviewCommentsMessageCard } from '@/components/sessions/reviews/messages/ReviewCommentsMessageCard';
import { ReviewFindingsV1Schema } from '@happier-dev/protocol';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export type StructuredMessageKind = 'review_comments.v1' | 'review_findings.v1';

export type StructuredMessageRendererParams = Readonly<{
    sessionId: string;
    onJumpToAnchor: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}>;

export type StructuredMessageRegistryEntry<T> = Readonly<{
    kind: StructuredMessageKind;
    schema: ZodSchema<T>;
    render: (payload: T, params: StructuredMessageRendererParams) => React.ReactElement;
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
]);

export function findStructuredMessageRenderer(kind: string): StructuredMessageRegistryEntry<any> | null {
    for (const entry of STRUCTURED_MESSAGE_REGISTRY) {
        if (entry.kind === kind) return entry;
    }
    return null;
}
