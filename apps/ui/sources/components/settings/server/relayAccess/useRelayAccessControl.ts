import * as React from 'react';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { TailscaleSecureAccessTaskResult } from '@happier-dev/protocol/system/tasks/tailscaleSecureAccessTaskContract';
import { RelayAccessTaskSnapshotV1Schema } from '@happier-dev/protocol/system/tasks/relayAccessConfigV1';
import { REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { getRelayAccessProviderDescriptor, readBuiltinRelayAccessProviderId, type RelayAccessConfig } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskSnapshot, RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import {
    buildRelayAccessDisableSystemTaskSpec,
    buildRelayAccessExecutionSystemTaskSpec,
    buildRelayAccessStatusSystemTaskSpec,
} from '@/components/systemTasks/specs/relayAccess/buildRelayAccessSystemTaskSpec';
import { t } from '@/text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useLocalRuntimeActionExecution } from '@/components/approvals/useLocalRuntimeActionExecution';
import { createUiHomeRuntimeActionClient } from '@/sync/ops/actions/homeRuntimeActionClient';

function readRelayAccessSnapshot(result: SystemTaskResult | null): RelayAccessTaskSnapshot | null {
    if (!result?.ok) {
        return null;
    }
    const parsed = RelayAccessTaskSnapshotV1Schema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    return result.error ? resolveSystemTaskFailureMessage(result.error) ?? null : null;
}

function readRelayAccessFailure(snapshot: RelayAccessTaskSnapshot) {
    const details = snapshot.status.details;
    if (snapshot.status.state !== 'error' || !isRecord(details)) return null;
    return {
        message: resolveSystemTaskFailureMessage({
            code: typeof details.code === 'string' ? details.code : null,
            message: typeof details.message === 'string' ? details.message : null,
        }) ?? null,
        retryable: typeof details.retryable === 'boolean' ? details.retryable : undefined,
    };
}

function readTailscaleSecureAccessSnapshot(
    selection: RelayAccessConfig,
    result: SystemTaskResult | null,
): RelayAccessTaskSnapshot | null {
    if (!result?.ok) {
        return null;
    }
    const data = result.data as Partial<TailscaleSecureAccessTaskResult> | null | undefined;
    if (!data || typeof data !== 'object') {
        return null;
    }
    const shareUrl = typeof data.shareableHttpsUrl === 'string' ? data.shareableHttpsUrl.trim() : '';
    const requiresApproval = data.requiresApproval && typeof data.requiresApproval === 'object'
        ? data.requiresApproval
        : null;

    return {
        configured: true,
        providerId: readBuiltinRelayAccessProviderId(selection.provider),
        selection,
        status: {
            state: requiresApproval ? 'needs_auth' : (shareUrl ? 'enabled' : 'unknown'),
            shareUrl: shareUrl.length > 0 ? shareUrl : null,
            details: {
                tailscaleInstalled: data.tailscaleInstalled === true,
                tailscaleLoggedIn: data.tailscaleLoggedIn === true,
                serveEnabled: data.serveEnabled === true,
                requiresApproval,
            },
        },
    };
}

type RelayAccessActionKind = 'relay.access.configure.v1' | 'relay.access.disable.v1';

export type RelayAccessControlOptions = Readonly<{
    runner?: SystemTaskRunner;
    target?: RelayAccessTaskTarget;
    upstreamUrl?: string | null;
    remoteHost?: Readonly<{ scope: ServerAccountScope; hostId: string; expectedRevision: number | 'absent' }>;
    actionScope?: ServerAccountScope;
    runWithTarget?: <T>(run: (target: RelayAccessTaskTarget, startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>) => Promise<T>;
}>;

export type RelayAccessControl = Readonly<{
    actionScope: ServerAccountScope | null;
    actionServerId: string;
    approval: ReturnType<typeof useLocalRuntimeActionExecution>['approval'];
    cancelTask: (taskId: string) => Promise<void>;
    activeTaskSnapshot: SystemTaskRunState | null;
    actionSnapshot: SystemTaskRunState | null;
    configure: (payload: Readonly<{ config: RelayAccessConfig }>) => Promise<string | null>;
    disable: () => Promise<string | null>;
    isBusy: boolean;
    isUnavailable: boolean;
    lastErrorMessage: string | null;
    refreshStatus: () => Promise<string | null>;
    snapshot: RelayAccessTaskSnapshot | null;
}>;

export function useRelayAccessControl(options: RelayAccessControlOptions = {}): RelayAccessControl {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const mountedAction = useLocalRuntimeActionExecution(options.actionScope ?? options.remoteHost?.scope, { runner });
    const runtimeAction = React.useMemo(() => createUiHomeRuntimeActionClient(runner, mountedAction.execute), [runner, mountedAction.execute]);
    const target = options.target ?? { kind: 'local' as const };
    const upstreamUrl = React.useMemo(() => {
        const value = typeof options.upstreamUrl === 'string' ? options.upstreamUrl.trim() : '';
        return value.length > 0 ? value : null;
    }, [options.upstreamUrl]);
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [actionTaskId, setActionTaskId] = React.useState<string | null>(null);
    const [lastSnapshot, setLastSnapshot] = React.useState<RelayAccessTaskSnapshot | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledActionTaskIdRef = React.useRef<string | null>(null);
    const lastActionSelectionRef = React.useRef<RelayAccessConfig | null>(null);
    const actionExecutorRef = React.useRef<Promise<ReturnType<typeof createDefaultActionExecutor>> | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const actionSnapshot = useSystemTaskSnapshot(runner, actionTaskId);

    const startTask = React.useCallback(async (kind: 'relay.access.status.v1' | RelayAccessActionKind, params?: Readonly<{
        config?: RelayAccessConfig;
    }>) => {
        try {
            if (!options.remoteHost && !options.runWithTarget && target.kind === 'local' && mountedAction.requiresAction) {
                const actionId = kind === 'relay.access.status.v1' ? 'relay.access.status'
                    : kind === 'relay.access.disable.v1' ? 'relay.access.disable' : 'relay.access.configure';
                const outcome = await runtimeAction(actionId, kind === 'relay.access.configure.v1' ? { ...params, upstreamUrl } : {});
                if (!('status' in outcome) || outcome.status !== 'task_started') {
                    throw new Error('reason' in outcome ? outcome.reason : t('settings.systemTaskStartFailed'));
                }
                setBridgeUnavailable(false);
                setLastErrorMessage(null);
                return outcome.taskId;
            }
            if (options.remoteHost) {
                // Capture the addressed host/Home before loading policy or awaiting consent.
                const { scope, hostId, expectedRevision } = options.remoteHost;
                const actionId = kind === 'relay.access.status.v1' ? 'remote_hosts.relay.access.status' : 'remote_hosts.relay.configure';
                const input = kind === 'relay.access.status.v1' ? { hostId, expectedRevision }
                    : { hostId, expectedRevision, operation: kind === 'relay.access.disable.v1'
                        ? { kind: 'disable' as const }
                        : { kind: 'configure' as const, config: params?.config } };
                actionExecutorRef.current ??= import('@/sync/ops/actions/defaultActionExecutor')
                    .then(owner => owner.createDefaultActionExecutor());
                const executor = await actionExecutorRef.current;
                const result = await executor.execute(actionId, input, {
                    surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
                });
                if (!result.ok) throw new Error(result.error);
                const parsed = REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(result.result);
                if (!parsed.success || parsed.data.status !== 'task_started') {
                    throw new Error(parsed.success && 'reason' in parsed.data ? parsed.data.reason : t('settings.systemTaskStartFailed'));
                }
                setBridgeUnavailable(false);
                setLastErrorMessage(null);
                return parsed.data.taskId;
            }
            const start = async (target: RelayAccessTaskTarget,
                startSpec: (spec: SystemTaskSpec) => Promise<string> = spec => mountedAction.runSignedOutDraft(() => runner.start(spec)),
                admittedUpstreamUrl?: string | null) =>
                kind === 'relay.access.status.v1'
                    ? await startSpec(buildRelayAccessStatusSystemTaskSpec({ target }))
                    : kind === 'relay.access.disable.v1'
                        ? await startSpec(buildRelayAccessDisableSystemTaskSpec({ target }))
                        : await startSpec(buildRelayAccessExecutionSystemTaskSpec({
                            target,
                            config: params?.config as RelayAccessConfig,
                            // Catalog admission supplies the execution target, including
                            // explicit absence; display/focused state cannot replace it.
                            upstreamUrl: admittedUpstreamUrl === undefined ? upstreamUrl : admittedUpstreamUrl,
                        }));
            const taskId = options.runWithTarget ? await options.runWithTarget(start) : await start(target);
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [mountedAction.requiresAction, mountedAction.runSignedOutDraft, options.remoteHost, options.runWithTarget, runner, runtimeAction, target, upstreamUrl]);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        const taskId = await startTask('relay.access.status.v1');
        if (!taskId) return null;
        setStatusTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

    const runAction = React.useCallback(async (kind: RelayAccessActionKind, payload?: Readonly<{
        config: RelayAccessConfig;
    }>) => {
        if (isUnavailable) {
            return null;
        }
        lastActionSelectionRef.current = payload?.config ?? null;
        const taskId = await startTask(kind, payload);
        if (!taskId) return null;
        handledActionTaskIdRef.current = null;
        setActionTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

    React.useEffect(() => {
        if (!mountedAction.ready) return;
        if (isUnavailable) return;
        if (autoRefreshRequestedRef.current) return;
        autoRefreshRequestedRef.current = true;
        void refreshStatus().catch(() => {});
    }, [isUnavailable, mountedAction.ready, refreshStatus]);

    React.useEffect(() => {
        const nextSnapshot = readRelayAccessSnapshot(statusSnapshot?.result ?? null);
        if (nextSnapshot) {
            setLastSnapshot(nextSnapshot);
            setLastErrorMessage(readRelayAccessFailure(nextSnapshot)?.message ?? null);
            return;
        }
        const errorMessage = readErrorMessage(statusSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [statusSnapshot]);

    React.useEffect(() => {
        if (!actionSnapshot?.result || handledActionTaskIdRef.current === actionSnapshot.taskId) {
            return;
        }
        handledActionTaskIdRef.current = actionSnapshot.taskId;
        if (!actionSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(actionSnapshot.result));
            return;
        }

        const selection = lastActionSelectionRef.current;
        if (selection && getRelayAccessProviderDescriptor(selection.provider).homeSetupTaskKind === 'secureAccess.tailscale.v1') {
            const inlineSnapshot = readTailscaleSecureAccessSnapshot(selection, actionSnapshot.result);
            if (inlineSnapshot) {
                setLastSnapshot(inlineSnapshot);
                setLastErrorMessage(null);
                void refreshStatus().catch(() => {});
                return;
            }
        }

        const inlineSnapshot = readRelayAccessSnapshot(actionSnapshot.result);
        if (inlineSnapshot) {
            setLastSnapshot(inlineSnapshot);
            const failure = readRelayAccessFailure(inlineSnapshot);
            setLastErrorMessage(failure?.message ?? null);
            if (failure?.retryable === false) return;
        }
        void refreshStatus().catch(() => {});
    }, [actionSnapshot, refreshStatus]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = actionSnapshot?.result ? null : actionSnapshot ?? (statusSnapshot?.result ? null : statusSnapshot);
        return snapshot ?? null;
    }, [actionSnapshot, statusSnapshot]);

    const isBusy = !mountedAction.ready || mountedAction.approval.approvalPending || (activeTaskSnapshot != null && activeTaskSnapshot.result == null);

    return {
        actionScope: mountedAction.binding?.scope ?? null,
        actionServerId: mountedAction.binding?.serverId ?? '',
        approval: mountedAction.approval,
        cancelTask: React.useCallback(async (taskId: string) => {
            try {
                if (!mountedAction.requiresAction) return await mountedAction.runSignedOutDraft(() => runner.cancel(taskId));
                const outcome = await runtimeAction('relay.runtime.task.cancel', { taskId });
                if (!('status' in outcome) || outcome.status === 'unavailable' || outcome.status === 'outcome_unknown') {
                    throw new Error('reason' in outcome ? outcome.reason : t('errors.operationFailed'));
                }
            } catch (error) {
                setLastErrorMessage(readSystemTaskStartErrorMessage(error) ?? t('errors.operationFailed'));
                throw error;
            }
        }, [mountedAction.requiresAction, mountedAction.runSignedOutDraft, runner, runtimeAction]),
        activeTaskSnapshot,
        actionSnapshot,
        configure: React.useCallback(async (payload: Readonly<{ config: RelayAccessConfig }>) => {
            return await runAction('relay.access.configure.v1', payload);
        }, [runAction]),
        disable: React.useCallback(async () => {
            return await runAction('relay.access.disable.v1');
        }, [runAction]),
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        snapshot: lastSnapshot,
    };
}
