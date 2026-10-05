import * as React from 'react';

import {
    readLocalDaemonSharedState,
    startLocalCliUpdate,
    subscribeLocalDaemonSharedState,
} from '@/components/settings/machines/localControl/localDaemonSharedState';
import { readKeptCliUpdateCommand, readLocalDaemonStatusData, type LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { buildThisComputerCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';

export type ThisComputerCliUpdate = Readonly<{
    /** `null` off the desktop app, and until this computer's status has answered. */
    item: UpdateItem | null;
    machineId: string | null;
    run: () => Promise<void>;
}>;

const NOOP = async () => {};

/**
 * This computer's Happier CLI row. It only observes the status every `useLocalDaemonControl`
 * mount shares (the app shell mounts one on desktop) and the one shared CLI-update run (S-10), so
 * the always-mounted summary may use it: it never starts a read of its own.
 */
export function useThisComputerCliUpdate(): ThisComputerCliUpdate {
    const desktop = React.useMemo(() => isDesktopHost(), []);
    const runner = getSystemTasksRunner();
    const subscribe = React.useCallback((listener: () => void) => subscribeLocalDaemonSharedState(runner, listener), [runner]);
    const read = React.useCallback(() => readLocalDaemonSharedState<LocalDaemonStatusData>(runner), [runner]);
    const shared = React.useSyncExternalStore(subscribe, read, read);
    const snapshot = useSystemTaskSnapshot(runner, shared.cliUpdate.taskId);
    const running = shared.cliUpdate.starting || shared.cliUpdate.rereading || (snapshot != null && snapshot.result == null);
    const errorMessage = shared.cliUpdate.errorMessage;
    const status = desktop ? shared.status : null;
    const cliUpdate = status?.cliUpdate ?? null;
    const machineId = status?.machineId ?? null;
    const keptCliUpdateCommand = readKeptCliUpdateCommand(status);

    const item = React.useMemo(() => {
        if (!cliUpdate) return null;
        return buildThisComputerCliUpdateItem({
            machineId: machineId ?? 'this-computer',
            title: t('updates.happierCliTitle'),
            facts: {
                currentVersion: cliUpdate.currentVersion,
                latestVersion: cliUpdate.latestVersion,
                managed: cliUpdate.managed,
                updateCommand: keptCliUpdateCommand,
            },
            task: { running, step: running ? 'installing' : null, errorMessage },
        });
    }, [cliUpdate, errorMessage, keptCliUpdateCommand, machineId, running]);

    const serverSnapshot = useActiveServerSnapshot();
    const activeScope = useActiveServerAccountScope();
    const startContext = React.useMemo(() => activeScope?.serverId === serverSnapshot.serverId ? {
        scope: activeScope,
        spec: buildLocalDaemonServiceSystemTaskSpec('cli.update.v1'),
        machineId,
    } : null, [activeScope, machineId, serverSnapshot]);
    const run = React.useCallback(async () => {
        if (!startContext) return;
        await startLocalCliUpdate(runner, readLocalDaemonStatusData, startContext);
    }, [runner, startContext]);

    return React.useMemo(() => ({ item, machineId, run: desktop ? run : NOOP }), [desktop, item, machineId, run]);
}
