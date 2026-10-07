import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
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
    const transcriptSource = useSessionTranscriptSource();
    const sessionId = transcriptSource.sessionId;
    const [dismissal, setDismissal] =
        React.useState<ExternalSessionOperationTranscriptDismissal | null>(null);

    React.useEffect(() => {
        setDismissal((current) =>
            current?.sessionId === sessionId ? current : null
        );
    }, [sessionId]);

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
            sessionId: sessionId,
            operationId: actionRef.operationId,
            revision: actionRef.revision,
        });
    }, [params.presentation, sessionId]);

    return React.useMemo(() => ({
        dismissal,
        onDismiss,
    }), [dismissal, onDismiss]);
}
