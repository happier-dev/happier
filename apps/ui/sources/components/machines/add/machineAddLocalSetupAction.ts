import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { readLocalDaemonSharedState, startLocalComputerSetup } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { readLocalDaemonStatusData, refreshLocalDaemonStatus, type LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { confirmThisComputerAccountMove } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { resolveThisComputerConnection } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { readMachineAddFlowDraft, updateMachineAddFlowDraft } from './machineAddFlowStore';
import { beginMachineAddWatch, hasRunningMachineAddTask, startMachineAddTask } from './machineAddTaskLifetime';

/** Cancellation consumes the start owner's retained task custody, including pending starts. */
export function createMachineAddLocalCancelAction(): NonNullable<ActionExecutorDeps['machineAddLocalCancel']> {
    return async ({ taskId }, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const active = getActiveServerSnapshot();
        const serverId = context.serverId ?? active.serverId;
        const scope = storage.getState().settingsScope;
        if (!scope?.accountId || !areServerProfileIdentifiersEquivalent(serverId, active.serverId)
            || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) return fail('active_home_required');
        if (context.expectedAccountId && context.expectedAccountId !== scope.accountId
            || context.runtimeAccountId && context.runtimeAccountId !== scope.accountId) return fail('action_account_scope_changed');
        const retained = readMachineAddFlowDraft();
        const handle = retained.thisComputerTask;
        if (!handle || !retained.serverId || !areServerProfileIdentifiersEquivalent(retained.serverId, serverId)) return fail('target_unavailable');
        if (!areAccountSettingsScopesEqual(handle.accountScope, scope)) return fail('action_account_scope_changed');
        if (!taskId) {
            if (!handle.starting || !handle.startPromise) return fail('target_unavailable');
            handle.unsubscribeCompletion?.();
            // The existing promise owner cancels an id that arrives after this release.
            updateMachineAddFlowDraft(draft => draft.thisComputerTask !== handle ? draft
                : { ...draft, thisComputerTask: null, startedAtMs: null, baseline: null });
            return { pendingCanceled: true };
        }
        if (handle.taskId !== taskId || !handle.runner.getSnapshot(taskId)) return fail('target_unavailable');
        try { await handle.runner.cancel(taskId); }
        catch { return fail('machine_enroll_cancel_failed'); }
        handle.unsubscribeCompletion?.();
        updateMachineAddFlowDraft(draft => draft.thisComputerTask !== handle ? draft : { ...draft, startedAtMs: null, baseline: null });
        return { taskId };
    };
}

/** The answering desktop consumes the existing local setup and retained Add-task owners. */
export function createMachineAddLocalSetupAction(runnerOverride?: SystemTaskRunner): NonNullable<ActionExecutorDeps['machineAddLocalStart']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const active = getActiveServerSnapshot();
        const state = storage.getState();
        const scope = state.settingsScope;
        if (!scope?.accountId || !areServerProfileIdentifiersEquivalent(input.serverId, active.serverId)
            || !areServerProfileIdentifiersEquivalent(scope.serverId, input.serverId)) return fail('active_home_required');
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, input.serverId)) return fail('server_scope_mismatch');
        if (context.expectedAccountId && context.expectedAccountId !== scope.accountId
            || context.runtimeAccountId && context.runtimeAccountId !== scope.accountId) return fail('action_account_scope_changed');
        const profile = getServerProfileById(input.serverId);
        if (!profile) return fail('target_unavailable');
        const isRelayRepair = 'purpose' in input && input.purpose === 'relay_repair';
        const reconsiderCli = 'reconsiderCli' in input ? input.reconsiderCli : undefined;
        const isEnrollment = !isRelayRepair && reconsiderCli !== true;
        const runner = runnerOverride ?? (isEnrollment ? readMachineAddFlowDraft().thisComputerTask?.runner : undefined) ?? getSystemTasksRunner();
        if (!resolveSetupSurfacePolicy().machine.allowLocalMachineSetup || (runner.mode !== 'tauri' && runner.mode !== 'dev')) return fail('machine_enroll_unavailable');
        if (isEnrollment && hasRunningMachineAddTask()) return fail('machine_enroll_in_progress');
        const approval = { expectedRelayUrl: profile.serverUrl, serverId: input.serverId, expectedAccountId: scope.accountId };
        const isAccountCurrent = () => areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
            && getActiveServerSnapshot().generation === active.generation;
        const startSetup = async (isCurrent: () => boolean) => {
            context.signal?.throwIfAborted();
            // An Agent can reach this owner without mounting the preflight presenter. Read
            // the same local status then; never treat an unloaded cache as no Account move.
            if (!readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status) {
                await refreshLocalDaemonStatus(runner, { signal: context.signal, isCurrent: () => isCurrent() && isAccountCurrent() });
            }
            if (!isCurrent() || !isAccountCurrent()) return null;
            const status = readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status;
            if (!status) throw new Error('local_service_status_unavailable');
            const connection = resolveThisComputerConnection({ daemon: status,
                activeRelayUrl: profile.serverUrl, activeLocalRelayUrl: active.activeLocalRelayUrl,
                appAccountId: scope.accountId, appAccountLabel: state.profile ? formatAccountDisplayName(state.profile) : null });
            if (!await confirmThisComputerAccountMove(connection)) return null;
            context.signal?.throwIfAborted();
            if (!isCurrent() || !isAccountCurrent()) return null;
            if (isEnrollment) beginMachineAddWatch(input.serverId, 'thisComputer');
            const target = {
                activeRelayUrl: profile.serverUrl, activeWebappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl),
                activeLocalRelayUrl: active.activeLocalRelayUrl, activeAccountId: scope.accountId,
            };
            const spec = isRelayRepair ? buildRelayDriftRepairSystemTaskSpec(target) : buildLocalMachineSetupSystemTaskSpec({
                ...target, activeServerIdentityId: profile.serverIdentityId,
                installService: true, startService: true, verifyService: true, reconsiderCli,
            });
            return startLocalComputerSetup(runner, spec, approval, readLocalDaemonStatusData);
        };
        if (isEnrollment) updateMachineAddFlowDraft(draft => ({ ...draft, serverId: input.serverId, path: 'thisComputer' }));
        const taskId = isEnrollment
            ? await startMachineAddTask('thisComputer', runner, startSetup)
            : await startSetup(() => true);
        return taskId ? { taskId } : fail(isEnrollment && readMachineAddFlowDraft().thisComputerTask ? 'machine_enroll_not_started' : 'cancelled');
    };
}
