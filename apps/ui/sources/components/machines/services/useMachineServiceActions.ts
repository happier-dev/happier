import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import * as React from 'react';
import { MachineServiceWatchMutationResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { showMachineTerminalSheet } from '@/components/machines/terminal/MachineTerminalSheet';
import { useServerScopedMachine } from '@/sync/store/hooks';

/** A project-level watch's own Compose members, only when there is a choice to make; one member needs no selector. */
const NO_MEMBERS: readonly string[] = Object.freeze([]);

type UnwatchOutcome = Readonly<{ kind: 'unwatched' | 'conflict' }>
  | Readonly<{ kind: 'failed'; code: string; failure?: ActionExecuteFailure }>;


/**
 * Bound Service entries consume the Machine's admitted role and the row's admitted exec capability (the handle that
 * runs the command decides it); the Actions still own authorization. `members` are the watch's own Compose services,
 * the set the exec owner validates a selection against.
 */
export function useMachineServiceActions(input: Readonly<{
  serverId: string; machineId: string; machineName: string; service: MachineServiceRowV1; offline: boolean;
}>) {
  const manage = useServerScopedMachine(input.serverId, input.machineId, canManageMachine);
  const execution = useMountedActionExecution(input.serverId);
  const { service } = input;
  const key = JSON.stringify([input.serverId, input.machineId, service.serviceId, service.generation,
    service.watchId, service.watchRevision]);
  const currentKey = React.useRef(key);
  currentKey.current = key;
  const flight = React.useRef<string | null>(null);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; binding: typeof execution.binding; pending: boolean; outcome: UnwatchOutcome | null;
  }> | null>(null);
  const current = record?.key === key && record.binding === execution.binding ? record : null;
  const enabled = manage && !input.offline && execution.ready;
  const generation = service.generation;
  const command = enabled && service.capabilities.exec === true && generation !== null;
  const composeServices = service.native?.composeServices;
  const members = composeServices && composeServices.length > 1 ? composeServices : NO_MEMBERS;
  const shell = command && generation !== null ? (member?: string) => showMachineTerminalSheet({
    serverId: input.serverId, machineId: input.machineId, machineName: input.machineName,
    launch: { kind: 'service_shell', serviceId: service.serviceId, expectedGeneration: generation,
      ...(member ? { service: member } : {}) },
  }) : null;
  const watchId = service.watchId;
  const watchRevision = service.watchRevision;
  const unwatch = enabled && watchId && watchRevision ? async () => {
    if (flight.current === key) return;
    flight.current = key;
    const binding = execution.binding;
    setRecord({ key, binding, pending: true, outcome: null });
    let outcome: UnwatchOutcome;
    try {
      const result = await execution.execute('machines.services.unwatch', {
        serverId: input.serverId, machineId: input.machineId, watchId, expectedRevision: watchRevision,
      }, { confirmed: true });
      if (!result.ok) outcome = { kind: 'failed', code: result.errorCode, failure: result };
      else {
        const parsed = MachineServiceWatchMutationResultV1Schema.safeParse(result.result);
        outcome = !parsed.success ? { kind: 'failed', code: 'action_invalid_output' }
          : parsed.data.kind === 'unavailable' ? { kind: 'failed', code: parsed.data.reason }
            : parsed.data.kind === 'conflict' ? { kind: 'conflict' } : { kind: 'unwatched' };
      }
    } catch (error: unknown) {
      const failure = normalizeActionExecutorThrownError(error, 'machines.services.unwatch');
      outcome = { kind: 'failed', code: failure.errorCode, failure };
    } finally {
      if (flight.current === key) flight.current = null;
    }
    if (currentKey.current === key && execution.isCurrent()) setRecord({ key, binding, pending: false, outcome });
  } : null;
  return { command, members, shell, unwatch, pending: current?.pending ?? false, outcome: current?.outcome ?? null };
}
