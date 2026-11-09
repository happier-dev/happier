import { SETTING_VALUE_UNAVAILABLE, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { refreshLocalDaemonStatus, type DesktopServiceAutostartMode, type LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { readActiveServerTaskScope } from '@/sync/domains/server/activeServerTaskScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import type { LocalDaemonServiceScope } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';

/** Both the desktop row and Settings Actions change the existing native service login trigger. */
export async function setDesktopLoginStartMode(runner: SystemTaskRunner, mode: DesktopServiceAutostartMode,
    context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean; statusIsCurrent?: () => boolean; scope?: LocalDaemonServiceScope }>): Promise<SystemTaskResult | undefined> {
    throwIfAborted(context?.signal);
    if (context?.isCurrent() === false) return;
    const scope = context ? context.scope ?? readActiveServerTaskScope() : undefined;
    const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.autostart.set.v1', {}, { autostart: mode }));
    let result;
    try {
        throwIfAborted(context?.signal);
        if (context?.isCurrent() === false) { await runner.cancel(taskId); return; }
        result = await waitForSystemTaskResult(runner, taskId, { signal: context?.signal });
    } catch (error) {
        if (context?.signal?.aborted) await runner.cancel(taskId);
        throw error;
    }
    // A failed change can still affect some services; show their actual common mode after either outcome.
    await refreshLocalDaemonStatus(runner, { scope, signal: context?.signal, isCurrent: context?.statusIsCurrent ?? context?.isCurrent });
    if (!result.ok) throw Object.assign(new Error(result.error.message || result.error.code), { code: result.error.code });
    return result;
}

function readLoginStartValue() {
    const mode = readLocalDaemonSharedState<LocalDaemonStatusData>(getSystemTasksRunner()).status?.serviceAutostart;
    return mode === 'at-login' ? true : mode === 'on-demand' ? false : SETTING_VALUE_UNAVAILABLE;
}

export const desktopLoginStartBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: [true, false],
    read: readLoginStartValue,
    parse: (value: unknown) => typeof value === 'boolean' ? { success: true, value } : { success: false },
    commit: async (_local, value, _writeLocal, context) => {
        if (readLoginStartValue() === SETTING_VALUE_UNAVAILABLE) return SETTING_VALUE_UNAVAILABLE;
        await setDesktopLoginStartMode(getSystemTasksRunner(), value === true ? 'at-login' : 'on-demand', context);
        return readLoginStartValue() === value ? undefined : SETTING_VALUE_UNAVAILABLE;
    },
} satisfies SettingStorageBinding;
