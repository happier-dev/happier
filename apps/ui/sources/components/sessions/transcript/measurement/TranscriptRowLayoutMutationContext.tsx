import * as React from 'react';

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';

export type TranscriptRowLayoutMutationReason = 'expand' | 'collapse' | 'signature-change';

export type TranscriptRowLayoutMutation = Readonly<{
    reason: TranscriptRowLayoutMutationReason;
    sourceId: string;
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
