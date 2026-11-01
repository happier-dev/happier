import * as React from 'react';
import { getReleaseRingPublicLabel } from '@happier-dev/release-runtime/releaseRings';

import { useCliUpdateTask } from '@/components/settings/machines/localControl/useCliUpdateTask';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readKeptCliUpdateCommand } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { desktopSetupCoordinator, resolveThisComputerServiceForActiveRelay } from '@/setup/desktopSetupCoordinator';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildThisComputerCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';

export type ThisComputerCliUpdate = Readonly<{
    /** `null` off the desktop app, and until this computer's inspection has answered. */
    item: UpdateItem | null;
    machineId: string | null;
    run: () => Promise<void>;
}>;

const NOOP = async () => {};

/**
 * This computer's Happier CLI row, from the one ambient inspection (never a read of its own) and
 * the one shared CLI-update action (S-10). Cheap: it subscribes to state other surfaces already
 * hold, so the always-mounted summary may use it.
 */
export function useThisComputerCliUpdate(): ThisComputerCliUpdate {
    const desktop = React.useMemo(() => isTauriDesktop(), []);
    const inspection = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionSnapshot,
        desktopSetupCoordinator.readInspectionSnapshot,
    );
    const serverId = useActiveServerSnapshot().serverId;
    const activeScope = useActiveServerAccountScope();
    const task = useCliUpdateTask();
    // The machine is the one that answers for the app's relay — its own pinned service's when it has
    // one here — so this row replaces that machine's row in the relay's machine list. The CLI facts
    // are this computer's one CLI's, whichever service reports them.
    const serving = desktop ? resolveThisComputerServiceForActiveRelay(inspection) : null;
    // The command line is this computer's one CLI whichever service reports it, so it stays listed
    // even when the app relay's own service could not be read; only the machine is then unknown.
    const facts = desktop ? serving?.facts ?? (inspection.status === 'resolved' ? inspection.facts : null) : null;
    const machineId = serving?.facts.auth.machineId ?? null;
    const cliUpdate = facts?.cliUpdate ?? null;
    const provenance = facts?.acquisition.provenance ?? null;
    const currentVersion = facts?.acquisition.version ?? cliUpdate?.currentVersion ?? null;
    const keptCliUpdateCommand = facts ? readKeptCliUpdateCommand(facts) : null;

    const item = React.useMemo(() => {
        if (!facts) return null;
        return buildThisComputerCliUpdateItem({
            machineId: machineId ?? 'this-computer',
            title: t('updates.happierCliTitle'),
            facts: {
                currentVersion,
                latestVersion: cliUpdate?.latestVersion ?? null,
                managed: provenance === 'managed' && cliUpdate?.managed !== false,
                updateCommand: keptCliUpdateCommand,
                channel: facts.acquisition.channel ? getReleaseRingPublicLabel(facts.acquisition.channel) : null,
            },
            task: { running: task.running, step: task.running ? 'installing' : null, errorMessage: task.errorMessage },
        });
    }, [cliUpdate?.latestVersion, cliUpdate?.managed, currentVersion, facts, keptCliUpdateCommand, machineId, provenance, task.errorMessage, task.running]);

    const startContext = React.useMemo(() => activeScope?.serverId === serverId ? {
        scope: activeScope,
        spec: buildLocalDaemonServiceSystemTaskSpec('cli.update.v1'),
        machineId,
    } : null, [activeScope, machineId, serverId]);
    const run = React.useCallback(async () => {
        if (!desktop || !item || !startContext) return;
        await task.start(startContext);
    }, [desktop, item, startContext, task.start]);
    return React.useMemo(() => ({ item, machineId, run: desktop ? run : NOOP }), [desktop, item, machineId, run]);
}
