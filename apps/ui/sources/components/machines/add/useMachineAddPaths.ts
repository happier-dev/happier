import * as React from 'react';
import { Platform } from 'react-native';
import { getNativeSshAvailability } from '@happier-dev/ssh-native';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachineListForServerSelection } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import {
    readLocalDaemonSharedState,
    subscribeLocalDaemonSharedState,
} from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isThisComputerMachineOfHome, resolveMachineAddPaths, type MachineAddDevice, type MachineAddPath } from './machineAddPaths';

/** What kind of device this is, for the ways in it can run: the desktop app, a browser, or the phone app. */
export function readMachineAddDevice(): MachineAddDevice {
    return isDesktopHost() ? 'desktop' : Platform.OS === 'web' ? 'browser' : 'phone';
}

/**
 * This computer's machine id as its local daemon reports it (`null` before it has one). Reads the
 * canonical status projection; it does not start another daemon status task.
 * An idle consumer neither creates the default task runner nor observes its status.
 */
export function useThisComputerMachineId(taskRunner?: SystemTaskRunner, enabled = true): string | null {
    const runner = enabled ? taskRunner ?? getSystemTasksRunner() : null;
    const subscribe = React.useCallback((listener: () => void) => runner ? subscribeLocalDaemonSharedState(runner, listener) : () => {}, [runner]);
    const read = React.useCallback(() => runner ? readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status?.machineId ?? null : null, [runner]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Reads the canonical status projection; it does not start another daemon status task. */
export function useMachineAddPaths(serverId?: string, taskRunner?: SystemTaskRunner): readonly MachineAddPath[] {
    const activeServer = useActiveServerSnapshot();
    const thisMachineId = useThisComputerMachineId(taskRunner);
    const device = readMachineAddDevice();
    const nativeSshAvailable = device === 'phone' && getNativeSshAvailability().available === true;
    const policy = React.useMemo(() => resolveSetupSurfacePolicy().machine, []);
    const selectJoined = React.useCallback((machines: readonly Machine[]) => isThisComputerMachineOfHome(thisMachineId, machines), [thisMachineId]);
    const joined = useMachineListForServerSelection(serverId ?? activeServer.serverId, selectJoined);
    return React.useMemo(() => resolveMachineAddPaths({
        device, thisComputerJoined: joined, thisComputerMachineId: joined ? thisMachineId : null, nativeSshAvailable, policy,
    }), [device, joined, nativeSshAvailable, policy, thisMachineId]);
}
