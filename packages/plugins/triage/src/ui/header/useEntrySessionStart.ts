import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartOptionsV1, type TriageEntrySessionStartControllerV1 } from '../../sessions/entrySessionStartController.js';
import {
    readTriageEntrySessionStartTargetV1, readTriageRecentSessionsV1,
    type TriageEntrySessionStartChoiceInputV1, type TriageEntrySessionStartChoicesHostV1,
    type TriageEntrySessionStartTargetV1, type TriageRecentSessionsV1,
} from '../../sessions/entryStartChoices.js';
export * from '../../sessions/entrySessionStartController.js';
export type { TriageRecentSessionV1, TriageEntrySessionStartTargetV1, TriageRecentSessionsV1 } from '../../sessions/entryStartChoices.js';

export function useTriageEntrySessionStart(options?: TriageEntrySessionStartOptionsV1): TriageEntrySessionStartControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const owner = React.useMemo(() => createTriageEntrySessionStartController(host, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    return React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}

export function useTriageEntrySessionStartChoices(
    input: TriageEntrySessionStartChoiceInputV1 & Readonly<{ menuOpen: boolean }>,
): Readonly<{ defaultTarget: TriageEntrySessionStartTargetV1; recentSessions: TriageRecentSessionsV1 }> {
    const host = usePluginHostApi() as unknown as TriageEntrySessionStartChoicesHostV1;
    const [defaultTarget, setDefaultTarget] = React.useState<TriageEntrySessionStartTargetV1>({ status: 'idle' });
    const [recentSessions, setRecentSessions] = React.useState<TriageRecentSessionsV1>({ status: 'idle' });
    const profileId = input.action?.profileId;
    const workspaceMode = input.action?.workspaceMode;
    const kind = input.repository?.kind;
    const deployment = input.repository?.deployment;
    const repository = input.repository?.repository;
    React.useEffect(() => {
        if (profileId === undefined || workspaceMode === undefined) { setDefaultTarget({ status: 'idle' }); return; }
        const lifetime = new AbortController();
        setDefaultTarget({ status: 'loading' });
        // The reader uses only these action facts; unrelated row objects do not create new demand.
        void readTriageEntrySessionStartTargetV1(host, {
            action: { profileId, workspaceMode },
            ...(kind === undefined || deployment === undefined || repository === undefined ? {}
                : { repository: { kind, deployment, repository } }),
        }, { signal: lifetime.signal }).then((result) => { if (!lifetime.signal.aborted) setDefaultTarget(result); });
        return () => lifetime.abort();
    }, [host, profileId, workspaceMode, kind, deployment, repository]);
    React.useEffect(() => {
        if (!input.menuOpen) { setRecentSessions({ status: 'idle' }); return; }
        const lifetime = new AbortController();
        setRecentSessions({ status: 'loading' });
        void readTriageRecentSessionsV1(host, true, { signal: lifetime.signal })
            .then((result) => { if (!lifetime.signal.aborted) setRecentSessions(result); });
        return () => lifetime.abort();
    }, [host, input.menuOpen]);
    return { defaultTarget, recentSessions };
}
