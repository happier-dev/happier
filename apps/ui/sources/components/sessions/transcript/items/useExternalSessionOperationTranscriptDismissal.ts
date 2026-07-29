import * as React from 'react';

import type { ExternalSessionOperationProgressV1 } from '@happier-dev/protocol';

import type { ExternalSessionOperationActionRef } from '@/components/sessions/external/progress/ExternalImportProgressCard';
import type { ExternalSessionOperationTranscriptDismissal } from '@/components/sessions/transcript/items/externalSessionOperationTranscriptItem';

function isDismissibleStatus(
    status: ExternalSessionOperationProgressV1['status'],
): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'discarded';
}

export function useExternalSessionOperationTranscriptDismissal(params: Readonly<{
    sessionId: string;
    progress: ExternalSessionOperationProgressV1 | null;
}>): Readonly<{
    dismissal: ExternalSessionOperationTranscriptDismissal | null;
    onDismiss: (actionRef: ExternalSessionOperationActionRef) => void;
}> {
    const [dismissal, setDismissal] =
        React.useState<ExternalSessionOperationTranscriptDismissal | null>(null);

    React.useEffect(() => {
        setDismissal((current) =>
            current?.sessionId === params.sessionId ? current : null
        );
    }, [params.sessionId]);

    const onDismiss = React.useCallback((
        actionRef: ExternalSessionOperationActionRef,
    ) => {
        if (
            params.progress === null
            || !isDismissibleStatus(params.progress.status)
            || params.progress.operationId !== actionRef.operationId
            || params.progress.revision !== actionRef.revision
        ) {
            return;
        }
        setDismissal({
            sessionId: params.sessionId,
            operationId: actionRef.operationId,
            revision: actionRef.revision,
        });
    }, [params.progress, params.sessionId]);

    return React.useMemo(() => ({
        dismissal,
        onDismiss,
    }), [dismissal, onDismiss]);
}
