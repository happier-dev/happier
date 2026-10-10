import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HomeRuntimeRestartOutputV1Schema } from '@happier-dev/protocol/home/runtime/actionsV1';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { SERVERS_SETTINGS } from '@/components/settings/server/serverSettings';
import { getDefaultSystemTaskRunner, waitForSystemTaskResult } from '@/components/systemTasks';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getRemoteHostCatalogSnapshot, useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import {
    findPersonalHomeBootstrapCompletedProfile,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiHomeRuntimeActionClient } from '@/sync/ops/actions/homeRuntimeActionClient';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

import { resolveHomeRuntimeExecutor, type HomeRuntimeExecutor } from './resolveHomeRuntimeExecutor';

export { homeRuntimeExecutorCanAct, resolveHomeRuntimeExecutor, type HomeRuntimeExecutor } from './resolveHomeRuntimeExecutor';

/** The executor for one Home on this device, from the live profile and Remote host facts. */
export function useHomeRuntimeExecutor(serverId: string, flavor: 'light' | 'full' | null): HomeRuntimeExecutor {
    const profilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [profilesGeneration]);
    const scope = useActiveServerAccountScope();
    const snapshot = useRemoteHostCatalogSnapshot(scope);
    const remoteHosts = snapshot?.data;
    const catalogRevision = snapshot && !snapshot.stale && snapshot.catalog.status === 'ready'
        && snapshot.catalog.cleanup !== 'pending' && typeof snapshot.catalog.revision === 'number' ? snapshot.catalog.revision : null;
    return React.useMemo(() => {
        const locallyHosted = findPersonalHomeBootstrapCompletedProfile(profiles);
        const scopeIdById = new Map(profiles.map((profile) => [profile.id, resolveServerProfileScopeId(profile)]));
        return resolveHomeRuntimeExecutor({
            serverId,
            flavor,
            localBridgeAvailable: settingRendersOnHost(SERVERS_SETTINGS.settings.accessMethod)
                && getDefaultSystemTaskRunner().mode !== 'unavailable',
            locallyHostedServerId: locallyHosted ? resolveServerProfileScopeId(locallyHosted) : null,
            remoteHosts: remoteHosts ?? [],
            remoteHostScope: scope,
            remoteHostCatalogRevision: catalogRevision,
            scopeIdOfProfile: (profileId) => scopeIdById.get(profileId) ?? null,
        });
    }, [serverId, flavor, profiles, remoteHosts, scope, catalogRevision]);
}

export type HomeRuntimeRestartOutcome =
    | Readonly<{ kind: 'restarted'; taskId: string; result: SystemTaskResult; runtimeStatusResult?: SystemTaskResult }>
    | Readonly<{ kind: 'cancelled'; taskId?: string; result?: SystemTaskResult }>
    | Readonly<{ kind: 'outcome_unknown'; taskId?: string; result?: SystemTaskResult; runtimeStatusResult?: SystemTaskResult }>
    | Readonly<{ kind: 'failed'; message: string | null; taskId?: string; result?: SystemTaskResult; runtimeStatusResult?: SystemTaskResult }>;

function readHealthy(data: unknown): boolean | null {
    return data && typeof data === 'object' && 'healthy' in data && typeof data.healthy === 'boolean' ? data.healthy : null;
}

function completedRestart(taskId: string, result: SystemTaskResult, runtimeStatusResult?: SystemTaskResult): HomeRuntimeRestartOutcome {
    const observed = runtimeStatusResult ?? result;
    const data = observed.ok ? observed.data : undefined;
    const health = runtimeStatusResult && data && typeof data === 'object' && 'relayRuntime' in data ? data.relayRuntime : data;
    const retained = { taskId, result, ...(runtimeStatusResult ? { runtimeStatusResult } : {}) };
    if (!observed.ok) return runtimeStatusResult
        ? { kind: 'outcome_unknown', ...retained }
        : { kind: 'failed', ...retained, message: observed.error.message };
    const healthy = readHealthy(health);
    return healthy === null ? { kind: 'outcome_unknown', ...retained }
        : healthy ? { kind: 'restarted', ...retained } : { kind: 'failed', ...retained, message: null };
}

/**
 * Restarts the runtime of a Home through its executor: the same relay-runtime restart task every
 * surface runs (Runtime's Restart, Server settings' Restart now), never a second restart path.
 */
export async function restartHomeRuntime(
    executor: HomeRuntimeExecutor,
    context: Readonly<{ serverId: string; secretMaterialAllowed: boolean; onApprovalPending?: (approval: ActionApprovalRegistration) => void; onAdmitted?: () => void; signal?: AbortSignal }>,
): Promise<HomeRuntimeRestartOutcome> {
    let taskId: string | undefined;
    let result: SystemTaskResult | undefined;
    try {
        switch (executor.kind) {
            case 'hosting_desktop': {
                const runner = getDefaultSystemTaskRunner();
                // Result-required local Actions await the canonical blocking approval owner.
                const action = createUiHomeRuntimeActionClient(runner);
                const outcome = await action('relay.runtime.restart', {}, { serverId: context.serverId, signal: context.signal });
                if ('status' in outcome && outcome.status === 'outcome_unknown') {
                    context.onAdmitted?.();
                    return { kind: 'outcome_unknown', ...(outcome.taskId ? { taskId: outcome.taskId } : {}) };
                }
                if (!('status' in outcome) || outcome.status !== 'task_started') return { kind: 'failed', message: null };
                taskId = outcome.taskId;
                context.onAdmitted?.();
                result = await waitForSystemTaskResult(runner, taskId, { signal: context.signal });
                return completedRestart(taskId, result);
            }
            case 'remote_host': {
                // This Action can require durable approval. Never submit it without a mounted
                // recipient for that receipt, then mistake pending approval for task failure.
                if (!context.onApprovalPending) return { kind: 'failed', message: null };
                const scope = executor.scope;
                const snapshot = getRemoteHostCatalogSnapshot(scope);
                if (!snapshot || snapshot.stale || snapshot.catalog.status !== 'ready' || snapshot.catalog.cleanup === 'pending'
                    || snapshot.catalog.revision !== executor.catalogRevision) return { kind: 'failed', message: null };
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const actions = createDefaultActionExecutor();
                const actionInput = { hostId: executor.host.id, expectedRevision: executor.catalogRevision };
                type Admission = Readonly<{ kind: 'completed'; value: unknown }>
                    | Readonly<{ kind: 'cancelled' }> | Readonly<{ kind: 'failed'; message: string }>;
                const admit = (actionId: 'remote_hosts.relay.restart' | 'remote_hosts.relay.status') =>
                    awaitActionApprovalResult<unknown, Admission>({
                        async execute(callbacks) {
                            const executed = await actions.execute(actionId, actionInput,
                                { surface: 'ui', authority: 'present_user', serverId: scope.serverId,
                                    expectedAccountId: scope.accountId, ...(context.signal ? { signal: context.signal } : {}) });
                            if (!executed.ok) return { kind: 'failed', message: executed.error };
                            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(executed.result);
                            if (!pending.success) return { kind: 'completed', value: executed.result };
                            if (pending.data.actionId !== actionId) return { kind: 'failed', message: 'approval_binding_mismatch' };
                            context.onApprovalPending!(createActionApprovalContinuation({
                                artifactId: pending.data.artifactId, actionId, scope, expectedInput: actionInput,
                                refreshAfterExecution: false,
                                ...(context.signal ? { signal: context.signal } : {}),
                                onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                            }));
                            return { approvalPending: true };
                        },
                        succeeded: value => ({ kind: 'completed', value }),
                        failed: code => code === 'approval_rejected' || code === 'approval_canceled'
                            ? { kind: 'cancelled' } : { kind: 'failed', message: code },
                        aborted: () => ({ kind: 'cancelled' }),
                        ...(context.signal ? { signal: context.signal } : {}),
                    });
                const started = await admit('remote_hosts.relay.restart');
                if (started.kind !== 'completed') return started;
                const admitted = REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1['remote_hosts.relay.restart'].safeParse(started.value);
                if (!admitted.success || admitted.data.status !== 'task_started') return { kind: 'failed', message: null };
                taskId = admitted.data.taskId;
                const runner = getDefaultSystemTaskRunner();
                result = await waitForSystemTaskResult(runner, taskId);
                if (!result.ok) return completedRestart(taskId, result);
                // SSH restart reports command completion, not health. Ask the existing status
                // task owner once, after completion, instead of treating admission as runtime up.
                const status = await admit('remote_hosts.relay.status');
                if (status.kind !== 'completed') return status.kind === 'cancelled'
                    ? { ...status, taskId, result } : { kind: 'outcome_unknown', taskId, result };
                const statusAdmission = REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1['remote_hosts.relay.status'].safeParse(status.value);
                if (!statusAdmission.success || statusAdmission.data.status !== 'task_started') return { kind: 'outcome_unknown', taskId, result };
                return completedRestart(taskId, result, await waitForSystemTaskResult(runner, statusAdmission.data.taskId));
            }
            case 'connected_machine': {
                if (!context.onApprovalPending) return { kind: 'failed', message: null };
                const account = await captureLazyActionAccountContext(context.serverId, context.signal);
                try {
                    const scope = { serverId: account.serverId, accountId: account.accountId };
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    const actions = createDefaultActionExecutor();
                    const actionId = 'home.runtime.restart' as const;
                    const actionInput = { machineId: executor.machineId,
                        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), mode: 'user' as const };
                    type Admission = Readonly<{ kind: 'completed'; value: unknown }>
                        | Readonly<{ kind: 'cancelled' }> | Readonly<{ kind: 'failed'; message: string | null }>;
                    const admitted = await awaitActionApprovalResult<unknown, Admission>({
                        async execute(callbacks) {
                            const executed = await actions.execute(actionId, actionInput, {
                                surface: 'ui', authority: 'present_user', serverId: scope.serverId,
                                expectedAccountId: scope.accountId,
                                operationAcceptance: { operationId: actionId, actionId, accept: value => {
                                    if (value && typeof value === 'object' && 'taskId' in value && typeof value.taskId === 'string') taskId = value.taskId;
                                    context.onAdmitted?.();
                                } },
                                ...(context.signal ? { signal: context.signal } : {}),
                            });
                            if (!executed.ok) return { kind: 'failed', message: executed.errorCode === 'request_not_sent' ? null : executed.error };
                            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(executed.result);
                            if (!pending.success) return { kind: 'completed', value: executed.result };
                            if (pending.data.actionId !== actionId) return { kind: 'failed', message: 'approval_binding_mismatch' };
                            context.onApprovalPending!(createActionApprovalContinuation({
                                artifactId: pending.data.artifactId, actionId, scope, expectedInput: actionInput,
                                refreshAfterExecution: false,
                                ...(context.signal ? { signal: context.signal } : {}),
                                onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                            }));
                            return { approvalPending: true };
                        },
                        succeeded: value => ({ kind: 'completed', value }),
                        failed: code => code === 'approval_rejected' || code === 'approval_canceled'
                            ? { kind: 'cancelled' } : { kind: 'failed', message: code },
                        aborted: () => ({ kind: 'cancelled' }),
                        ...(context.signal ? { signal: context.signal } : {}),
                    });
                    if (admitted.kind !== 'completed') return admitted;
                    const output = HomeRuntimeRestartOutputV1Schema.safeParse(admitted.value);
                    if (!output.success) return { kind: 'outcome_unknown', ...(taskId ? { taskId } : {}) };
                    if (output.data.status === 'outcome_unknown') return { kind: 'outcome_unknown',
                        ...(output.data.taskId ? { taskId: output.data.taskId } : {}) };
                    if (output.data.status === 'unavailable') return { kind: 'failed', message: null };
                    return completedRestart(output.data.taskId, output.data.result);
                } finally { account.dispose(); }
            }
            case 'elsewhere':
            case 'deployment':
                return { kind: 'failed', message: null };
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error
            && (error.code === 'approval_canceled' || error.code === 'approval_rejected')) return { kind: 'cancelled' };
        if (taskId || readRpcRequestDisposition(error) === 'outcomeUnknown') {
            return { kind: 'outcome_unknown', ...(taskId ? { taskId } : {}), ...(result ? { result } : {}) };
        }
        return { kind: 'failed', ...(taskId ? { taskId } : {}), ...(result ? { result } : {}), message: error instanceof Error ? error.message : null };
    }
}
