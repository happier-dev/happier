import * as React from 'react';
import { MachineServiceWatchMutationResultV1Schema, MachineServicesDiscoveryResultV1Schema, type MachineServiceDiscoveryCandidateV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import type { MachineServiceWatchChoice } from './machineServicesPresentation';

const execute = createFrontDoorActionExecute();
const settle = (promise: Promise<ActionExecuteResult>) => promise.catch((error: unknown): ActionExecuteResult => ({
  ok: false, errorCode: 'action_failed', error: error instanceof Error ? error.message : String(error),
}));

export type MachineServiceDiscovery =
  | Readonly<{ kind: 'idle' | 'reading' | 'unavailable' }>
  | Readonly<{ kind: 'listed'; candidates: readonly MachineServiceDiscoveryCandidateV1[] }>;
export type MachineServiceWatchOutcome = Readonly<{ kind: 'approval' }> | Readonly<{ kind: 'failed'; count: number }>;

/**
 * Watch a service (lab `services/watch`): `machines.services.discovery` runs only when the person opens the picker,
 * then one `machines.services.watch` per picked candidate at the revision they saw. A watched service is what
 * `Watched` lists (development purpose). Success says nothing of its own: the list Resource shows the new rows.
 */
export function useMachineServiceWatch(input: Readonly<{ serverId: string; machineId: string }>) {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const [discovery, setDiscovery] = React.useState<MachineServiceDiscovery>({ kind: 'idle' });
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<MachineServiceWatchOutcome | null>(null);
  const discover = React.useCallback(() => {
    if (!lifetime?.isCurrent()) return;
    setDiscovery(previous => previous.kind === 'listed' ? previous : { kind: 'reading' });
    setOutcome(null);
    void settle(execute('machines.services.discovery', { serverId: input.serverId, machineId: input.machineId },
      { serverId: input.serverId, surface: 'ui', expectedAccountId: lifetime.scope.accountId }))
      .then((result) => {
        const parsed = result.ok ? MachineServicesDiscoveryResultV1Schema.safeParse(result.result) : null;
        setDiscovery(parsed?.success && parsed.data.kind === 'snapshot'
          ? { kind: 'listed', candidates: parsed.data.candidates } : { kind: 'unavailable' });
      });
  }, [lifetime, input.serverId, input.machineId]);
  const watch = React.useCallback(async (choices: readonly MachineServiceWatchChoice[]): Promise<boolean> => {
    if (pending || choices.length === 0 || !lifetime?.isCurrent()) return false;
    setPending(true);
    setOutcome(null);
    let failed = 0;
    let approval = false;
    for (const choice of choices) {
      const result = await settle(execute('machines.services.watch', {
        serverId: input.serverId, machineId: input.machineId, candidateId: choice.candidateId,
        expectedRevision: choice.revision, lifecyclePurpose: 'development',
      }, { serverId: input.serverId, surface: 'ui', expectedAccountId: lifetime.scope.accountId }));
      const parsed = result.ok ? MachineServiceWatchMutationResultV1Schema.safeParse(result.result) : null;
      if (parsed?.success && (parsed.data.kind === 'applied' || parsed.data.kind === 'unchanged')) continue;
      if (result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) { approval = true; continue; }
      failed++;
    }
    setPending(false);
    setOutcome(failed > 0 ? { kind: 'failed', count: failed } : approval ? { kind: 'approval' } : null);
    return failed === 0 && !approval;
  }, [pending, lifetime, input.serverId, input.machineId]);
  return { discovery, discover, watch, pending, outcome };
}
