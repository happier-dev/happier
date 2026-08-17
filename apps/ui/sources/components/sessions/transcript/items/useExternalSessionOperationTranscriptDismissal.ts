import * as React from 'react';

import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import type { ExternalSessionOperationActionRef } from '@/components/sessions/external/progress/ExternalImportProgressCard';
import {
    isExternalSessionOperationDismissibleStatus,
} from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';
import type { ExternalSessionOperationTranscriptDismissal } from '@/components/sessions/transcript/items/externalSessionOperationTranscriptItem';

export function useExternalSessionOperationTranscriptDismissal(params: Readonly<{
    sessionId: string;
    presentation: ExternalSessionOperationSharedPresentationV1 | null;
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
            params.presentation === null
            || !isExternalSessionOperationDismissibleStatus(
                params.presentation.status,
            )
            || params.presentation.operationId !== actionRef.operationId
            || params.presentation.revision !== actionRef.revision
        ) {
            return;
        }
        setDismissal({
            sessionId: params.sessionId,
            operationId: actionRef.operationId,
            revision: actionRef.revision,
        });
    }, [params.presentation, params.sessionId]);

    return React.useMemo(() => ({
        dismissal,
        onDismiss,
    }), [dismissal, onDismiss]);
}
