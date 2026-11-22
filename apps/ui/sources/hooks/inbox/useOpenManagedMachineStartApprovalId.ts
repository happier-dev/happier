import * as React from 'react';
import type { ManagedMachineRefV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readOpenManagedMachineStartApprovalId } from '@/sync/domains/artifacts/approvalArtifacts';
import { storage } from '@/sync/domains/state/storageStore';
import { useInboxArtifactBodyDemand } from './useInboxArtifactSource';

/**
 * The open Start Ask waiting for the person on one created Machine, or null. Inbox bodies are demanded only while
 * a consumer asks about a Machine (`machine` set), so an awake or unmanaged surface reads nothing.
 */
export function useOpenManagedMachineStartApprovalId(
  machine: ManagedMachineRefV1 | null | undefined,
): string | null {
  const active = Boolean(machine);
  useInboxArtifactBodyDemand(active);
  const entries = storage((state) =>
    active ? state.artifactOpenApprovalEntries : null,
  );
  const homeId = machine?.homeId;
  const managedId = machine?.managedId;
  return React.useMemo(
    () =>
      entries && homeId && managedId
        ? readOpenManagedMachineStartApprovalId(Object.values(entries), {
            homeId,
            managedId,
          })
        : null,
    [entries, homeId, managedId],
  );
}
