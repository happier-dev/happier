import type { Session } from '@/sync/domains/state/storageTypes';
import {
  useIsMachineListSettled,
  useServerScopedMachine,
} from '@/sync/store/hooks';

import { isSessionMachineAccessRemoved } from './sessionMachineAccessRemoved';

const selectPresent = (machine: unknown): boolean => machine !== null;

/**
 * Whether this Session's Machine left the viewer's settled Machine list: the one access-loss fact the Session view
 * and its list row both read. Subscribes to the Machine's presence only, never its record.
 */
export function useSessionMachineAccessRemoved(
  input: Readonly<{
    serverId: string | null | undefined;
    session: Pick<Session, 'access' | 'accessLevel'> | null | undefined;
    machineId: string | null | undefined;
  }>,
): boolean {
  const machinePresent = useServerScopedMachine(
    input.serverId,
    input.machineId ?? '',
    selectPresent,
  );
  const inventorySettled = useIsMachineListSettled(input.serverId);
  return isSessionMachineAccessRemoved({
    session: input.session,
    machineId: input.machineId,
    inventorySettled,
    machinePresent,
  });
}
