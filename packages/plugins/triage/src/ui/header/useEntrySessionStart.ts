import * as React from 'react';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectPluginActionControlExecutionV1 } from '@happier-dev/plugin-ui/hostApi';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartOptionsV1, type TriageEntrySessionStartControllerV1 } from '../../sessions/entrySessionStartController.js';
import {
    readTriageEntrySessionStartTargetV1, readTriageRecentSessionsV1,
    type TriageEntrySessionStartChoiceInputV1, type TriageEntrySessionStartChoicesHostV1,
    type TriageEntrySessionStartTargetV1, type TriageRecentSessionsV1,
} from '../../sessions/entryStartChoices.js';
export * from '../../sessions/entrySessionStartController.js';
export type { TriageRecentSessionV1, TriageEntrySessionStartTargetV1, TriageRecentSessionsV1 } from '../../sessions/entryStartChoices.js';

export type TriageEntrySessionStartUiControllerV1 = Omit<TriageEntrySessionStartControllerV1, 'settleAction'> & Readonly<{ settleAction: PluginUiActionControlController['onSettled'] }>;

export function useTriageEntrySessionStart(options?: TriageEntrySessionStartOptionsV1): TriageEntrySessionStartUiControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const text = usePluginTranslation();
    const owner = React.useMemo(() => createTriageEntrySessionStartController(host, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const settleAction = React.useCallback<PluginUiActionControlController['onSettled']>(execution => {
        owner.getSnapshot().settleAction(projectPluginActionControlExecutionV1(execution, text));
    }, [owner, text]);
    return React.useMemo(() => ({ ...snapshot, settleAction }), [snapshot, settleAction]);
}

/**
 * The last settled default target per action shape, so a detail opened after the first one keeps "Fix with Claude"
 * while its own read revalidates instead of drawing "Fix" and growing (last-known value while refreshing).
 */
const LAST_DEFAULT_TARGETS = new Map<string, TriageEntrySessionStartTargetV1>();
/**
 * The agent half of that target depends on the action alone (its profile), not on the entry's repository: an entry
 * in a repository not opened yet still names the last settled agent while its own read settles, so the primary keeps
 * its settled width from first paint ("Review with Claude", F10) instead of growing under the row.
 */
const LAST_DEFAULT_AGENT_LABELS = new Map<string, string>();

export function useTriageEntrySessionStartChoices(
    input: TriageEntrySessionStartChoiceInputV1 & Readonly<{ menuOpen: boolean }>,
): Readonly<{ defaultTarget: TriageEntrySessionStartTargetV1; recentSessions: TriageRecentSessionsV1; settlingAgentLabel?: string }> {
    const host = usePluginHostApi() as unknown as TriageEntrySessionStartChoicesHostV1;
    const targetKey = [input.action?.profileId, input.action?.workspaceMode, input.repository?.kind,
        input.repository?.deployment, input.repository?.repository].map((part) => String(part ?? '')).join('\u001f');
    const [defaultTarget, setDefaultTarget] = React.useState<TriageEntrySessionStartTargetV1>(
        () => LAST_DEFAULT_TARGETS.get(targetKey) ?? { status: 'idle' });
    const [recentSessions, setRecentSessions] = React.useState<TriageRecentSessionsV1>({ status: 'idle' });
    const profileId = input.action?.profileId;
    const workspaceMode = input.action?.workspaceMode;
    const kind = input.repository?.kind;
    const deployment = input.repository?.deployment;
    const repository = input.repository?.repository;
    React.useEffect(() => {
        if (profileId === undefined || workspaceMode === undefined) { setDefaultTarget({ status: 'idle' }); return; }
        const lifetime = new AbortController();
        const lastKnown = LAST_DEFAULT_TARGETS.get(targetKey);
        setDefaultTarget(lastKnown ?? { status: 'loading' });
        // The reader uses only these action facts; unrelated row objects do not create new demand.
        void readTriageEntrySessionStartTargetV1(host, {
            action: { profileId, workspaceMode },
            ...(kind === undefined || deployment === undefined || repository === undefined ? {}
                : { repository: { kind, deployment, repository } }),
        }, { signal: lifetime.signal }).then((result) => {
            if (lifetime.signal.aborted) return;
            if (result.status === 'ready') LAST_DEFAULT_TARGETS.set(targetKey, result);
            if (result.status === 'ready' && result.agent != null) LAST_DEFAULT_AGENT_LABELS.set(`${profileId}\u001f${workspaceMode}`, result.agent.label);
            setDefaultTarget(result);
        });
        return () => lifetime.abort();
    }, [host, profileId, workspaceMode, kind, deployment, repository, targetKey]);
    React.useEffect(() => {
        if (!input.menuOpen) { setRecentSessions({ status: 'idle' }); return; }
        const lifetime = new AbortController();
        setRecentSessions({ status: 'loading' });
        void readTriageRecentSessionsV1(host, true, { signal: lifetime.signal, eligibility: {
            action: input.action, ...(input.repository === undefined ? {} : { repository: input.repository }),
        } })
            .then((result) => { if (!lifetime.signal.aborted) setRecentSessions(result); });
        return () => lifetime.abort();
    }, [host, input.menuOpen, workspaceMode, kind, deployment, repository]);
    const settlingAgentLabel = defaultTarget.status === 'loading'
        ? LAST_DEFAULT_AGENT_LABELS.get(`${String(profileId ?? '')}\u001f${String(workspaceMode ?? '')}`) : undefined;
    return { defaultTarget, recentSessions, ...(settlingAgentLabel === undefined ? {} : { settlingAgentLabel }) };
}
