import * as React from 'react';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { t } from '@/text';

import {
  presentThisComputerConnection,
  resolveThisComputerRepairTitle,
} from './thisComputerConnectionPresentation';
import { useLocalDaemonControl } from './useLocalDaemonControl';
import { useThisComputerConnection } from './useThisComputerConnection';

export type ThisComputerServiceSummary = Readonly<{
  /** `false` while the service serves this Home, or before its first read answers: healthy and unknown stay quiet. */
  needsYou: boolean;
  /** The state in a few words ("Background service is stopped"); `null` while quiet. */
  title: string | null;
  /** One sentence naming the Home or what to do; `null` when the title says it all. */
  description: string | null;
  /** What the last read or operation reported, when it failed. */
  error: string | null;
  /** The one operation this state needs: Install, Start or Repair. */
  action: Readonly<{
    label: string;
    disabled: boolean;
    run: () => void;
  }> | null;
  busy: boolean;
}>;

/**
 * This computer's background service, as one state and its one primary operation, for surfaces that show it
 * compactly (the Machines list, Add a machine). It reads the same `useLocalDaemonControl` owner and the same
 * connection classification as Settings › This machine, so every surface agrees. `null` where this device has no
 * local service to describe (web, phones).
 */
export function useThisComputerServiceSummary(
  options: Readonly<{ runner?: SystemTaskRunner }> = {},
): ThisComputerServiceSummary | null {
  const control = useLocalDaemonControl(options.runner ? { runner: options.runner } : {});
  const connection = useThisComputerConnection(control.status);
  const {
    status,
    lastErrorMessage,
    isUnavailable,
    isBusy,
    canInstall,
    canStart,
    canRepair,
    showInstallBackgroundService,
    installBackgroundService,
    startDaemonService,
    repairBackgroundService,
  } = control;
  return React.useMemo((): ThisComputerServiceSummary | null => {
    if (isUnavailable) return null;
    const install = {
      label: t('sessionGettingStarted.steps.daemonInstall.title'),
      disabled: !canInstall,
      run: () => {
        void installBackgroundService();
      },
    };
    const repair = {
      label: resolveThisComputerRepairTitle(connection),
      disabled: !canRepair,
      run: () => {
        void repairBackgroundService();
      },
    };
    if (!status) {
      // The status could not be read (a service that cannot start, as a missing module): say so with Repair.
      return lastErrorMessage
        ? {
            needsYou: true,
            title: t('settingsMachines.thisComputerNotWorking'),
            description: null,
            error: lastErrorMessage,
            action: repair,
            busy: isBusy,
          }
        : {
            needsYou: false,
            title: null,
            description: null,
            error: null,
            action: null,
            busy: isBusy,
          };
    }
    if (connection?.status === 'aligned') {
      return {
        needsYou: false,
        title: null,
        description: null,
        error: lastErrorMessage,
        action: null,
        busy: isBusy,
      };
    }
    const presentation = connection
      ? presentThisComputerConnection(connection)
      : null;
    const notInstalled =
      !connection || connection.status === 'daemon_not_installed';
    const action =
      notInstalled && showInstallBackgroundService
        ? install
        : connection?.status === 'daemon_not_running' && canStart
          ? {
              label: t('machine.thisComputer.action.daemon_not_running'),
              disabled: false,
              run: () => {
                void startDaemonService();
              },
            }
          : repair;
    return {
      needsYou: true,
      title:
        presentation?.title ??
        t('machine.thisComputer.title.daemon_not_installed'),
      description: presentation?.description ?? null,
      error: lastErrorMessage,
      action,
      busy: isBusy,
    };
  }, [
    canInstall,
    canRepair,
    canStart,
    connection,
    installBackgroundService,
    isBusy,
    isUnavailable,
    lastErrorMessage,
    repairBackgroundService,
    showInstallBackgroundService,
    startDaemonService,
    status,
  ]);
}
