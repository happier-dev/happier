import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';

export type ExternalSessionOperationTranscriptDismissal = Readonly<{
    sessionId: string;
    operationId: string;
    revision: number;
}>;

export function appendExternalSessionOperationTranscriptItem(
    base: readonly ChatTranscriptListItem[],
    operation: Readonly<{
        presentation: ExternalSessionOperationSharedPresentationV1 | null;
        progress: ExternalSessionOperationProgressV1 | null;
    }>,
    presentation?: Readonly<{
        sessionId: string;
        dismissed: ExternalSessionOperationTranscriptDismissal | null;
    }>,
): ChatTranscriptListItem[] {
    if (!operation.presentation) return [...base];
    const progress = (
        operation.progress?.operationId === operation.presentation.operationId
        && operation.progress.revision === operation.presentation.revision
    )
        ? operation.progress
        : null;
    if (
        presentation?.dismissed !== null
        && presentation?.dismissed !== undefined
        && presentation.dismissed.sessionId === presentation.sessionId
        && presentation.dismissed.operationId === operation.presentation.operationId
        && presentation.dismissed.revision === operation.presentation.revision
    ) {
        return [...base];
    }
    return [...base, {
        kind: 'external-session-operation',
        id: `external-session-operation:${operation.presentation.operationId}`,
        presentation: operation.presentation,
        progress,
        createdAt: 0,
    }];
}
