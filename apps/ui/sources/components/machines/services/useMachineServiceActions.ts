import * as React from 'react';
import { MachineServiceWatchMutationResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { showMachineTerminalSheet } from '@/components/machines/terminal/MachineTerminalSheet';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';

type UnwatchOutcome = Readonly<{ kind: 'unwatched' | 'conflict' }> | Readonly<{ kind: 'failed'; code: string }>;
const canManage = (machine: Machine | null): boolean => machine !== null
  && (machine.isShared === false || machine.access?.role === 'manage');

/** Bound Service entries consume the Machine's admitted role; the Actions still own authorization. */
export function useMachineServiceActions(input: Readonly<{
  serverId: string; machineId: string; machineName: string; service: MachineServiceRowV1;
  environmentId: string | null; offline: boolean;
}>) {
  const manage = useServerScopedMachine(input.serverId, input.machineId, canManage);
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
  const command = enabled && input.environmentId !== null && generation !== null;
  const shell = enabled && input.environmentId !== null && generation !== null ? () => showMachineTerminalSheet({
    serverId: input.serverId, machineId: input.machineId, machineName: input.machineName,
    launch: { kind: 'service_shell', serviceId: service.serviceId, expectedGeneration: generation },
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
      if (!result.ok) outcome = { kind: 'failed', code: result.errorCode };
      else {
        const parsed = MachineServiceWatchMutationResultV1Schema.safeParse(result.result);
        outcome = !parsed.success ? { kind: 'failed', code: 'action_invalid_output' }
          : parsed.data.kind === 'unavailable' ? { kind: 'failed', code: parsed.data.reason }
            : parsed.data.kind === 'conflict' ? { kind: 'conflict' } : { kind: 'unwatched' };
      }
    } catch {
      outcome = { kind: 'failed', code: 'action_failed' };
    } finally {
      if (flight.current === key) flight.current = null;
    }
    if (currentKey.current === key && execution.isCurrent()) setRecord({ key, binding, pending: false, outcome });
  } : null;
  return { command, shell, unwatch, pending: current?.pending ?? false, outcome: current?.outcome ?? null };
}
