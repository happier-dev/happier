import React from 'react';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

type SessionAuthoringDraftState = SessionAuthoringDraft | null;
type SessionAuthoringDraftUpdate = React.SetStateAction<SessionAuthoringDraftState>;

export function useSessionAuthoringDraftState(
    initialDraft: SessionAuthoringDraftState = null,
): Readonly<{
    draft: SessionAuthoringDraftState;
    setDraft: React.Dispatch<SessionAuthoringDraftUpdate>;
    latestDraftRef: React.MutableRefObject<SessionAuthoringDraftState>;
}> {
    const [draft, setDraftState] = React.useState<SessionAuthoringDraftState>(initialDraft);
    const latestDraftRef = React.useRef<SessionAuthoringDraftState>(initialDraft);

    const setDraft = React.useCallback((update: SessionAuthoringDraftUpdate) => {
        const current = latestDraftRef.current;
        const next = typeof update === 'function'
            ? (update as (current: SessionAuthoringDraftState) => SessionAuthoringDraftState)(current)
            : update;
        latestDraftRef.current = next;
        setDraftState(next);
    }, []);

    return {
        draft,
        setDraft,
        latestDraftRef,
    };
}
