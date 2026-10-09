import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { useMachinePoolProjections } from '@/sync/engine/machines/useMachinePoolProjections';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

export type WorkerDestinationLabel = Readonly<{
  /** The destination's own name (a Machine or a Pool), or null while it is not known. */
  name: string | null;
  /** The saved destination no longer resolves on a settled projection: explicit repair, no silent substitute. */
  missing: boolean;
}>;

/**
 * Names a saved or chosen Project execution choice from the canonical Machine and Pool projections.
 * "This machine" is the checkout's own Machine; an unresolved Pool stays unnamed until its Home's
 * Pool answer settles, and only a settled answer without it is reported missing.
 */
export function useWorkerDestinationLabel(
  serverId: string,
  choice: ProjectExecutionChoiceV1 | null,
  sourceMachineId: string | null,
): WorkerDestinationLabel {
  const destination = choice?.kind === 'workers' ? choice.destination : null;
  const machineId =
    choice?.kind === 'primary'
      ? (sourceMachineId ?? '')
      : destination?.kind === 'machine'
        ? destination.machineId
        : '';
  const machine = useServerScopedMachine(serverId, machineId);
  const scopes = React.useMemo(
    () => (destination?.kind === 'pool' ? [{ serverId, machines: [] }] : []),
    [destination?.kind, serverId],
  );
  const projection = useMachinePoolProjections(scopes)[0];
  if (!choice) return { name: null, missing: false };
  if (choice.kind === 'primary')
    return {
      name: machine
        ? (getMachineDisplayName(machine) ?? t('projectWorkers.primary'))
        : t('projectWorkers.primary'),
      missing: false,
    };
  if (destination?.kind === 'machine') {
    return machine
      ? { name: getMachineDisplayName(machine) ?? machineId, missing: false }
      : { name: null, missing: true };
  }
  const poolId = destination?.kind === 'pool' ? destination.poolId : null;
  const pool = projection?.pools.find((view) => view.pool.id === poolId);
  if (pool) return { name: pool.pool.name, missing: false };
  return { name: null, missing: projection?.ready === true };
}
