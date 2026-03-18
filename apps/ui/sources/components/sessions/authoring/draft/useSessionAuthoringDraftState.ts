import React from 'react';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export function useSessionAuthoringDraftState(initialDraft: SessionAuthoringDraft | null = null) {
    const [draft, setDraft] = React.useState<SessionAuthoringDraft | null>(initialDraft);
    const latestDraftRef = React.useRef<SessionAuthoringDraft | null>(draft);

    React.useEffect(() => {
        latestDraftRef.current = draft;
    }, [draft]);

    return {
        draft,
        setDraft,
        latestDraftRef,
    };
}

