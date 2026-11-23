import * as React from 'react';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1 } from '@happier-dev/plugin-ui/hostApi';
import { usePluginHostApi, usePluginTranslation, usePluginUiEphemeralSharedScope, useSurfaceContext } from '@happier-dev/plugin-ui';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartOptionsV1, type TriageEntrySessionStartControllerV1 } from '../../sessions/entrySessionStartController.js';
import {
    readTriageEntrySessionStartTargetV1, readTriageRecentSessionsV1,
    type TriageEntrySessionStartChoiceInputV1, type TriageEntrySessionStartChoicesHostV1,
    type TriageEntrySessionStartTargetV1, type TriageRecentSessionsV1,
} from '../../sessions/entryStartChoices.js';
export * from '../../sessions/entrySessionStartController.js';
export type { TriageRecentSessionV1, TriageEntrySessionStartTargetV1, TriageRecentSessionsV1 } from '../../sessions/entryStartChoices.js';

export type TriageEntrySessionStartUiControllerV1 = Omit<TriageEntrySessionStartControllerV1, 'settleAction'> & Readonly<{ settleAction: PluginUiActionControlController['onSettled'] }>;

export function projectTriageEntrySessionSettlement(
    execution: Parameters<typeof projectPluginActionControlExecutionV1>[0],
    translate: Parameters<typeof projectPluginActionControlExecutionV1>[1],
): ReturnType<typeof projectPluginActionControlExecutionV1> {
    const settlement = projectPluginActionControlExecutionV1(execution, translate);
    return isPluginActionConfirmationDeclined(settlement) ? { status: 'idle' } : settlement;
}

export function useTriageEntrySessionStart(options?: TriageEntrySessionStartOptionsV1): TriageEntrySessionStartUiControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const text = usePluginTranslation();
    const owner = React.useMemo(() => createTriageEntrySessionStartController(host, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const settleAction = React.useCallback<PluginUiActionControlController['onSettled']>(execution => {
        owner.getSnapshot().settleAction(projectTriageEntrySessionSettlement(execution, text));
    }, [owner, text]);
    return React.useMemo(() => ({ ...snapshot, settleAction }), [snapshot, settleAction]);
}

export function useTriageEntrySessionStartChoices(
    input: TriageEntrySessionStartChoiceInputV1 & Readonly<{ menuOpen: boolean }>,
): Readonly<{ defaultTarget: TriageEntrySessionStartTargetV1; recentSessions: TriageRecentSessionsV1; settlingAgentLabel?: string }> {
    const host = usePluginHostApi() as unknown as TriageEntrySessionStartChoicesHostV1;
    const scope = usePluginUiEphemeralSharedScope();
    const profileId = input.action?.profileId;
    const preferredAgentLabel = useSurfaceContext().preferredAgent?.label;
    const hasAccountPreferredAgent = profileId === null && preferredAgentLabel !== undefined;
    const workspaceMode = input.action?.workspaceMode;
    const kind = input.repository?.kind;
    const deployment = input.repository?.deployment;
    const repository = input.repository?.repository;
    const targetKey = JSON.stringify([profileId, workspaceMode, kind, deployment, repository]);
    const [settled, setSettled] = React.useState<Readonly<{
        host: typeof host; scope: typeof scope; key: string; target: TriageEntrySessionStartTargetV1;
        profileLabel?: string;
    }> | null>(null);
    const current = settled?.host === host && settled.scope === scope && settled.key === targetKey ? settled : null;
    const defaultTarget: TriageEntrySessionStartTargetV1 = hasAccountPreferredAgent ? { status: 'idle' }
        : current?.target ?? { status: 'idle' };
    const [recentSessions, setRecentSessions] = React.useState<TriageRecentSessionsV1>({ status: 'idle' });
    React.useLayoutEffect(() => {
        if (profileId === undefined || workspaceMode === undefined || hasAccountPreferredAgent) return;
        const lifetime = new AbortController();
        const profileLabels = profileId === null ? null : scope?.acquire('triage.entry-profile-labels.v1', () => {
            const labels = new Map<string, string>();
            return { value: labels, retainWhenIdle: true, dispose: () => labels.clear() };
        });
        const profileLabel = profileId === null ? undefined : profileLabels?.value.get(profileId);
        setSettled({ host, scope, key: targetKey, target: { status: 'loading' },
            ...(profileLabel === undefined ? {} : { profileLabel }) });
        // Repository and placement are current only once this entry's read settles.
        void readTriageEntrySessionStartTargetV1(host, {
            action: { profileId, workspaceMode },
            ...(kind === undefined || deployment === undefined || repository === undefined ? {}
                : { repository: { kind, deployment, repository } }),
        }, { signal: lifetime.signal }).then((result) => {
            if (lifetime.signal.aborted) return;
            if (profileId !== null && result.status === 'ready' && result.agent !== null) {
                profileLabels?.value.set(profileId, result.agent.label);
            }
            setSettled({ host, scope, key: targetKey, target: result });
        });
        return () => { lifetime.abort(); profileLabels?.release(); };
    }, [host, scope, profileId, workspaceMode, kind, deployment, repository, targetKey, hasAccountPreferredAgent]);
    React.useEffect(() => {
        if (!input.menuOpen) { setRecentSessions({ status: 'idle' }); return; }
        const lifetime = new AbortController();
        setRecentSessions({ status: 'loading' });
        void readTriageRecentSessionsV1(host, true, { signal: lifetime.signal, eligibility: {
            action: input.action, ...(input.repository === undefined ? {} : { repository: input.repository }),
        } })
            .then((result) => { if (!lifetime.signal.aborted) setRecentSessions(result); });
        return () => lifetime.abort();
    }, [host, scope, input.menuOpen, profileId, workspaceMode, kind, deployment, repository]);
    // The host's Account choice already names the default. Placement is resolved when someone actually presses.
    const settlingAgentLabel = defaultTarget.status === 'loading' || defaultTarget.status === 'idle'
        ? profileId === null ? preferredAgentLabel : current?.profileLabel
        : undefined;
    return { defaultTarget, recentSessions, ...(settlingAgentLabel === undefined ? {} : { settlingAgentLabel }) };
}
