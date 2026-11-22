import type { ActionExecutorDeps} from '@happier-dev/protocol/actions/executor/types';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1, LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS, LocalCliPathExposureSetInputSchema, LocalDaemonServiceAutostartInputSchema } from '@happier-dev/protocol/actions/specs/localDaemonService';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { refreshLocalDaemonStatus, readLocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isLocalCliUpdateRunning, publishLocalDaemonStatus, publishLocalDaemonServiceStartTask, startLocalCliUpdate } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { setDesktopLoginStartMode } from '@/components/settings/desktop/desktopLoginStart';
import { disconnectThisComputerFromHome } from '@/components/serverProfiles/disconnectThisComputerFromHome';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

/** Project the existing native task and completion owners; no separate service state or registry. */
export function createLocalDaemonServiceAction(options: Readonly<{ runner?: SystemTaskRunner; account?: LazyActionAccountContext }>): NonNullable<ActionExecutorDeps['localDaemonServiceAction']> {
    return async (actionId, input, context) => {
        const fail = (errorCode: string, error = errorCode) => ({ ok: false as const, errorCode, error });
        const request = LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS[actionId].parse(input);
        const runner = options.runner ?? getSystemTasksRunner();
        if (runner.mode !== 'tauri' && runner.mode !== 'dev') return fail('local_service_unavailable');
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, request.serverId)) return fail('server_scope_mismatch');
        if (options.account && !areServerProfileIdentifiersEquivalent(options.account.serverId, request.serverId)) return fail('server_scope_mismatch');
        const account = options.account ?? await captureLazyActionAccountContext(request.serverId, context.signal);
        const retired = new AbortController();
        const retirement = account.accountLifetime.onRetire(() => retired.abort());
        const cancellation = mergeAbortSignals([context.signal, retired.signal]);
        const signal = cancellation.signal;
        const isCurrent = account.accountLifetime.isCurrent;
        const scope = { relayUrl: account.endpointUrl, serverIdentityId: account.serverIdentityId };
        const canPublish = () => {
            const active = getActiveServerAccountScope();
            return isCurrent() && active?.accountId === account.accountId && areServerProfileIdentifiersEquivalent(active.serverId, account.serverId);
        };
        const settled = (result: SystemTaskResult) => result.ok ? { taskId: result.taskId, result } : fail(result.error.code, result.error.message);
        try {
            account.assertCurrent();
            throwIfAborted(signal);
            if (actionId === 'machines.local.service.autostart.set') {
                const { autostart } = LocalDaemonServiceAutostartInputSchema.parse(input);
                const result = await setDesktopLoginStartMode(runner, autostart, { scope, signal, isCurrent, statusIsCurrent: canPublish });
                return result ? settled(result) : fail('action_account_scope_changed');
            }
            if (actionId === 'machines.local.service.update') {
                const result = await startLocalCliUpdate(runner, readLocalDaemonStatusData, {
                    scope: { serverId: account.serverId, accountId: account.accountId },
                    // A local-computer Action cannot attribute cached status to this explicit Home's machine.
                    spec: buildLocalDaemonServiceSystemTaskSpec('cli.update.v1', scope), machineId: null,
                    signal, isCurrent,
                });
                throwIfAborted(signal);
                return result ? settled(result) : fail(isLocalCliUpdateRunning(runner) ? 'cli_update_in_progress' : 'local_service_update_failed');
            }
            if (actionId === 'machines.local.service.disconnect') {
                const outcome = await disconnectThisComputerFromHome({ serverUrl: account.endpointUrl, serverIdentityId: account.serverIdentityId }, runner, { signal });
                if (outcome.kind === 'removed' || outcome.kind === 'no_service' || outcome.kind === 'user_owned') {
                    await refreshLocalDaemonStatus(runner, { scope, signal, isCurrent: canPublish });
                    return outcome.kind === 'user_owned' ? { outcome: outcome.kind, label: outcome.label } : { outcome: outcome.kind };
                }
                return fail(outcome.kind === 'inventory_unavailable' ? 'service_inventory_unavailable' : outcome.kind === 'canceled' ? 'canceled' : 'service_disconnect_failed');
            }
            const kinds = { 'machines.local.service.status': 'daemon.service.status.v1',
                'machines.local.service.start': 'daemon.service.start.v1', 'machines.local.service.stop': 'daemon.service.stop.v1',
                'machines.local.service.restart': 'daemon.service.restart.v1' } as const;
            const isPathExposure = actionId === LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1;
            const kind = isPathExposure
                ? LocalCliPathExposureSetInputSchema.parse(input).enabled ? 'cli.pathExposure.ensure.v1' : 'cli.pathExposure.remove.v1'
                : kinds[actionId];
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind, scope));
            if (actionId === 'machines.local.service.start') publishLocalDaemonServiceStartTask(runner, taskId,
                { serverId: account.serverId, accountId: account.accountId });
            let result: SystemTaskResult;
            try { result = await waitForSystemTaskResult(runner, taskId, { signal }); }
            catch (error) { if (signal?.aborted) await runner.cancel(taskId); throw error; }
            throwIfAborted(signal);
            if (!result.ok || isPathExposure) return settled(result);
            if (actionId === 'machines.local.service.status') {
                const status = readLocalDaemonStatusData(result);
                if (status && canPublish()) publishLocalDaemonStatus(runner, status);
            } else await refreshLocalDaemonStatus(runner, { scope, signal, isCurrent: canPublish });
            return settled(result);
        } finally {
            cancellation.dispose(); retirement.dispose();
            if (!options.account) account.dispose();
        }
    };
}
