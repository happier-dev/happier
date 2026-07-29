import * as React from 'react';

import type {
    TranscriptRowLayoutMutation,
    TranscriptRowLayoutMutationHandler,
} from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import { resolveRowLayoutMutationViewportOwnershipAction } from './rowLayoutMutationViewportOwnership';
import type { TranscriptListShellRef } from './TranscriptListShell';

export function useRendererOwnedTranscriptRowLayoutMutation<TItem>(): Readonly<{
    listRef: React.RefObject<TranscriptListShellRef<TItem> | null>;
    prepareRowLayoutMutation: TranscriptRowLayoutMutationHandler;
}> {
    const listRef = React.useRef<TranscriptListShellRef<TItem> | null>(null);
    const prepareRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation): void => {
        const ownershipAction = resolveRowLayoutMutationViewportOwnershipAction({
            reason: mutation.reason,
        });
        if (ownershipAction === 'arm-visible-anchor-hold') {
            listRef.current?.armVisibleAnchorHold?.();
        }
    }, []);

    return {
        listRef,
        prepareRowLayoutMutation,
    };
}
