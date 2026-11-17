import * as React from 'react';

import { useWorkflowTriggerEventOptions } from '@/components/workflows/triggers/useWorkflowTriggerEventOptions';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

import { readWorkflowEventDraftSeed } from './workflowEventFacts';

/** Only the selected native fact borrows the editor's existing demanded Event catalog. */
export function useWorkflowEventDraftSeed(
  fact: Parameters<typeof readWorkflowEventDraftSeed>[0] | null,
  active: boolean,
  catalogMachineId?: string | null,
): ReturnType<typeof readWorkflowEventDraftSeed> {
  const accountLifetime = useActiveServerAccountScopeLifetime();
  const catalog = useWorkflowTriggerEventOptions({
    machineId: catalogMachineId ?? (fact?.kind === 'machine' ? fact.machineId : null),
    serverId: accountLifetime?.scope.serverId ?? null,
    accountLifetime,
    enabled: active && fact?.kind === 'machine',
  });
  return React.useMemo(() => fact === null ? null : readWorkflowEventDraftSeed(fact, {
    serverId: accountLifetime?.scope.serverId ?? null,
    events: catalog.events,
  }), [fact, accountLifetime, catalog.events]);
}
