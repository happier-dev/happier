import * as React from 'react';

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';

export type TranscriptRowLayoutMutationReason = 'expand' | 'collapse' | 'content-change' | 'signature-change';

export type TranscriptRowLayoutMutation = Readonly<{
    reason: TranscriptRowLayoutMutationReason;
    sourceId: string;
    /**
     * C1: the signature pair for a `signature-change` mutation. Rows report it so the viewport
     * ownership seam can arm the renderer's visible-anchor hold before an in-viewport height
     * commit (tool/thinking expansion) displaces the mounted window.
     */
    previousSignature?: TranscriptItemHeightValiditySignature;
    nextSignature?: TranscriptItemHeightValiditySignature;
}>;

export type TranscriptRowLayoutMutationHandler = (mutation: TranscriptRowLayoutMutation) => void;

const TranscriptRowLayoutMutationContext = React.createContext<TranscriptRowLayoutMutationHandler | null>(null);

export const TranscriptRowLayoutMutationProvider = TranscriptRowLayoutMutationContext.Provider;

export function useTranscriptRowLayoutMutation(): TranscriptRowLayoutMutationHandler {
    const handler = React.useContext(TranscriptRowLayoutMutationContext);
    return React.useCallback((mutation: TranscriptRowLayoutMutation) => {
        handler?.(mutation);
    }, [handler]);
}
