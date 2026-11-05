import * as React from 'react';
import { MachineServiceControlResultV1Schema, MachineServicesDetailResultV1Schema, type MachineServiceAccountingV1, type MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { type MachineServiceNativeRuntimeFactsV1 } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();
const settle = (promise: Promise<ActionExecuteResult>) => promise.catch((error: unknown): ActionExecuteResult => ({
  ok: false, errorCode: 'action_failed', error: error instanceof Error ? error.message : String(error),
}));

export type MachineServiceDetailFacts = Readonly<{
  accounting: MachineServiceAccountingV1 | null;
  runtimeFacts: MachineServiceNativeRuntimeFactsV1 | null;
}>;

/**
 * The open service's detail: one `machines.services.detail` read per visible open of a generation (plan 30 §3.2b:
 * one native accounting sample per detail open, none while hidden or list-only). Its facts are extra: the page
 * reads fine without them, so a refusal or failure leaves them out instead of replacing the page.
 */
export function useMachineServiceDetail(input: Readonly<{
  serverId: string; machineId: string; serviceId: string; generation: string | null; active: boolean;
}>): MachineServiceDetailFacts | null {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const key = JSON.stringify([input.serverId, input.machineId, input.serviceId, input.generation]);
  const [record, setRecord] = React.useState<Readonly<{ key: string; facts: MachineServiceDetailFacts }> | null>(null);
  React.useEffect(() => {
    if (!input.active || input.generation === null || !lifetime?.isCurrent()) return;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    void settle(execute('machines.services.detail', {
      serverId: input.serverId, machineId: input.machineId, serviceId: input.serviceId, expectedGeneration: input.generation,
    }, { serverId: input.serverId, surface: 'ui', expectedAccountId: lifetime.scope.accountId, signal: controller.signal }))
      .then((result) => {
        if (controller.signal.aborted || !result.ok) return;
        const parsed = MachineServicesDetailResultV1Schema.safeParse(result.result);
        if (!parsed.success || parsed.data.kind !== 'service') return;
        setRecord({ key, facts: { accounting: parsed.data.accounting ?? null, runtimeFacts: parsed.data.runtimeFacts ?? null } });
      })
      .finally(() => retirement.dispose());
    return () => controller.abort();
  }, [key, lifetime, input.active, input.serverId, input.machineId, input.serviceId, input.generation]);
  return record?.key === key ? record.facts : null;
}

export type MachineServiceControlOperation = 'restart' | 'stop' | 'start';
export type MachineServiceControlOutcome =
  | Readonly<{ kind: 'approval' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'failed' }>;

/**
 * Start, Stop and Restart through the one `machines.services.control` Action for the generation the page shows. One
 * operation at a time: a second press while one runs does nothing. Success says nothing of its own: the list Resource
 * the page follows reports what the service does next. Only a result that needs the person stays on the page.
 */
export function useMachineServiceControl(input: Readonly<{
  serverId: string; machineId: string; service: Pick<MachineServiceRowV1, 'serviceId' | 'generation'>;
}>) {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const key = JSON.stringify([input.serverId, input.machineId, input.service.serviceId, input.service.generation]);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; pending: MachineServiceControlOperation | null; outcome: MachineServiceControlOutcome | null;
  }> | null>(null);
  const running = React.useRef(false);
  const run = React.useCallback((operation: MachineServiceControlOperation) => {
    const generation = input.service.generation;
    if (running.current || generation === null || !lifetime?.isCurrent()) return;
    running.current = true;
    setRecord({ key, pending: operation, outcome: null });
    void settle(execute('machines.services.control', {
      serverId: input.serverId, machineId: input.machineId, serviceId: input.service.serviceId,
      expectedGeneration: generation, operation,
    }, { serverId: input.serverId, surface: 'ui', expectedAccountId: lifetime.scope.accountId }))
      .then((result) => {
        let outcome: MachineServiceControlOutcome | null = { kind: 'failed' };
        if (result.ok) {
          const parsed = MachineServiceControlResultV1Schema.safeParse(result.result);
          if (parsed.success) {
            outcome = parsed.data.kind === 'outcome_unknown' ? { kind: 'unknown' }
              : parsed.data.kind === 'unsupported' ? { kind: 'unsupported' } : null;
          } else if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) outcome = { kind: 'approval' };
        }
        setRecord({ key, pending: null, outcome });
      })
      .finally(() => { running.current = false; });
  }, [key, lifetime, input.serverId, input.machineId, input.service.serviceId, input.service.generation]);
  const current = record?.key === key ? record : null;
  return { pending: current?.pending ?? null, outcome: current?.outcome ?? null, run };
}
