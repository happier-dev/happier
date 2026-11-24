import * as React from 'react';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1 } from '@happier-dev/plugin-ui/hostApi';
import { usePluginHostApi, usePluginTranslation, usePluginUiEphemeralSharedScope, useSurfaceContext } from '@happier-dev/plugin-ui';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartOptionsV1, type TriageEntrySessionStartControllerV1, type TriageEntrySessionStartPhaseV1 } from '../../sessions/entrySessionStartController.js';
import {
    readTriageEntrySessionStartTargetV1,
    type TriageEntrySessionStartChoiceInputV1, type TriageEntrySessionStartChoicesHostV1,
    type TriageEntrySessionStartTargetV1,
} from '../../sessions/entryStartChoices.js';
export * from '../../sessions/entrySessionStartController.js';
export type { TriageEntrySessionStartTargetV1 } from '../../sessions/entryStartChoices.js';

export type TriageEntrySessionStartUiControllerV1 = Omit<TriageEntrySessionStartControllerV1, 'settleAction'> & Readonly<{ settleAction: PluginUiActionControlController['onSettled'] }>;

export function projectTriageEntrySessionSettlement(
    execution: Parameters<typeof projectPluginActionControlExecutionV1>[0],
    translate: Parameters<typeof projectPluginActionControlExecutionV1>[1],
): ReturnType<typeof projectPluginActionControlExecutionV1> {
    const settlement = projectPluginActionControlExecutionV1(execution, translate);
    return isPluginActionConfirmationDeclined(settlement) ? { status: 'idle' } : settlement;
}

function createReviewStartScope(controller: ReturnType<typeof createTriageEntrySessionStartController>, retire: () => void) {
    const value: { controller?: typeof controller; settlement?: TriageEntrySessionStartPhaseV1 } = { controller };
    return {
        value,
        retainWhenIdle: true as const,
        onIdle: () => {
            const retained = value.controller?.dispose(settlement => {
                delete value.controller;
                value.settlement = settlement;
            });
            if (!retained) retire();
        },
        dispose: () => { value.controller?.dispose(); },
    };
}

export function useTriageEntrySessionStart(
    options?: TriageEntrySessionStartOptionsV1 & Readonly<{ reviewKey?: string }>,
): TriageEntrySessionStartUiControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const text = usePluginTranslation();
    const scope = usePluginUiEphemeralSharedScope();
    const reviewKey = options?.reviewKey;
    const local = React.useMemo(() => createTriageEntrySessionStartController(host, options), [host, options?.mintCreationKey, scope, reviewKey]);
    const [shared, setShared] = React.useState<Readonly<{ local: typeof local; owner: typeof local }> | null>(null);
    React.useLayoutEffect(() => {
        const lease = scope === null || reviewKey === undefined ? null : scope.acquire(`triage.review-entry-start.v1:${reviewKey}`, () => ({
            ...createReviewStartScope(local, () => lease?.retire?.()),
        }));
        if (lease === null) {
            local.activate(host);
            return () => local.dispose();
        }
        const owner = lease.value.controller ?? local;
        owner.activate(host, lease.value.settlement);
        lease.value.controller = owner;
        delete lease.value.settlement;
        setShared({ local, owner });
        return lease.release;
    }, [scope, reviewKey, local, host]);
    const owner = shared?.local === local ? shared.owner : local;
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const settleAction = React.useCallback<PluginUiActionControlController['onSettled']>(execution => {
        owner.getSnapshot().settleAction(projectTriageEntrySessionSettlement(execution, text));
    }, [owner, text]);
    return React.useMemo(() => ({ ...snapshot, settleAction }), [snapshot, settleAction]);
}

export function useTriageEntrySessionStartChoices(
    input: TriageEntrySessionStartChoiceInputV1,
): Readonly<{ defaultTarget: TriageEntrySessionStartTargetV1; settlingAgentLabel?: string }> {
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
    // The host's Account choice already names the default. Placement is resolved when someone actually presses.
    const settlingAgentLabel = defaultTarget.status === 'loading' || defaultTarget.status === 'idle'
        ? profileId === null ? preferredAgentLabel : current?.profileLabel
        : undefined;
    return { defaultTarget, ...(settlingAgentLabel === undefined ? {} : { settlingAgentLabel }) };
}
