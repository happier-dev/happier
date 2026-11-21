import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CurrentAccountMachineInventoryItem } from './resolveCurrentAccountMachineTarget';

/** Classify the already-read requester inventory before disclosing or dispatching an Action. */
export async function resolveOriginalAccountMachineTarget(input: Readonly<{
  actionId: string;
  machineId: string;
  machines: readonly CurrentAccountMachineInventoryItem[] | undefined;
  accountId: string | null;
  accountMode: 'plain' | 'e2ee';
  authenticationKind: string | undefined;
  authority: ActionExecutorContext['authority'];
  credentialProvenance: StoredCredentials['credentialProvenance'];
  managedAdmission: boolean;
  isCurrent: () => Promise<boolean>;
}>): Promise<
  | Readonly<{ kind: 'ready'; machine: CurrentAccountMachineInventoryItem; foreign: boolean }>
  | Readonly<{ kind: 'refused'; execution: Extract<ActionExecuteResult, { ok: false }> }>
> {
  const refuse = (errorCode: string, details?: Readonly<{ machineId: string }>) => ({
    kind: 'refused' as const,
    execution: { ok: false as const, errorCode, error: errorCode, ...(details ? { details } : {}),
      failureCause: projectActionFailureCauseV1({ code: errorCode }, 'dispatch.machine_selection') },
  });
  if (!input.machines) return refuse('machine_inventory_unavailable');
  const machine = input.machines.find(row => row.id === input.machineId);
  if (!machine || machine.kind !== 'persistent' || machine.revokedAt !== null || machine.replacedByMachineId !== null
    || !machine.access || machine.access.accessState !== 'ready') return refuse('admission_unavailable');
  if (!await input.isCurrent()) return refuse('target_unavailable');
  const foreign = machine.access.custodian.accountId !== input.accountId;
  if (!foreign && machine.access.resourceMode !== input.accountMode) return refuse('admission_unavailable');
  if (foreign && ((input.authenticationKind !== 'account' && input.authenticationKind !== 'terminal')
    || input.authenticationKind === 'account' && input.authority === 'account_automation'
    || input.credentialProvenance === 'api_token') && !input.managedAdmission) return refuse('requester_account_material_unavailable');
  // Finite/deferred Actions can retain offline targets. A new Session needs a live Machine.
  if (input.actionId === 'session.spawn_new' && !machine.active) return refuse('machine_offline', { machineId: machine.id });
  return { kind: 'ready', machine, foreign };
}
