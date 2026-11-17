import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';

export type MachineIsolationAvailability = Readonly<{
  /** Why nothing about where work runs can change right now, or null when it can. */
  readOnlyReason: string | null;
  /** The viewer manages the Machine and it is offline: the offline line says so once, under the page head. */
  offline: boolean;
}>;

/**
 * Whether the viewer can change where work runs on this Machine right now, decided once for every door that leads
 * there (the Isolation page, its add row and invite, the Sandboxes tab's invite): only someone who manages it, and
 * only while it is online.
 */
export function describeMachineIsolationAvailability(
  machine: Machine,
  online: boolean | null,
  machineName: string,
): MachineIsolationAvailability {
  if (!canManageMachine(machine))
    return {
      readOnlyReason: t('machineDetailPage.isolation.notManager'),
      offline: false,
    };
  if (online !== true)
    return {
      readOnlyReason: t('machineDetailPage.isolation.offline', {
        machine: machineName,
      }),
      offline: true,
    };
  return { readOnlyReason: null, offline: false };
}

/**
 * The one offline line under a sandbox page's head (lab scene 1 `offline`): what it uses stays shown, as of when the
 * Machine was last seen, with the one Retry.
 */
export function MachineIsolationOfflineLine(
  props: Readonly<{
    serverId: string;
    machine: Machine;
    reason: string;
    testID: string;
  }>,
) {
  const { serverId } = props;
  const retry = React.useCallback(() => {
    void getSyncSingleton()
      .refreshMachines({ serverId })
      .catch(() => {});
  }, [serverId]);
  return (
    <SurfaceFreshnessLine
      testID={props.testID}
      glyph="cloud-slash"
      asOf={props.machine.activeAt}
      reason={props.reason}
      action={{ label: t('common.retry'), onPress: retry }}
    />
  );
}
