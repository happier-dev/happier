import * as React from 'react';
import {
  readMachineResourcesPolicyV1,
  type MachineMonitoringPolicyV1,
} from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';

import type { MachineResourceKey } from './machineRpc';

/** Read the same mode from metadata an existing Machine subscriber already holds. */
export function readMachineMonitoringMode(metadata: unknown): MachineMonitoringPolicyV1['mode'] | null {
  if (metadata === null) return null;
  const policy = readMachineResourcesPolicyV1(metadata);
  return policy.status === 'ready' ? policy.policy.monitoring.mode : null;
}

/**
 * A machine's saved monitoring mode, or null while its policy can't be read. It selects the machine's
 * metadata by reference and reads only `monitoring.mode`, so a vitals surface re-renders when the mode
 * changes, never on another policy edit or an unrelated machine update.
 */
export function useMachineMonitoringMode(
  input: MachineResourceKey,
): MachineMonitoringPolicyV1['mode'] | null {
  const active = useActiveServerSnapshot(!input.serverId);
  const serverId = input.serverId?.trim() || active.serverId;
  const metadata: unknown = storage(
    React.useCallback(
      (state: ReturnType<typeof storage.getState>) =>
        resolveServerScopedMachine(state, serverId, input.machineId)
          ?.metadata ?? null,
      [serverId, input.machineId],
    ),
  );
  return React.useMemo(() => readMachineMonitoringMode(metadata), [metadata]);
}
