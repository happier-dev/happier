import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import type { MachineAccessRefusalCode } from '@happier-dev/protocol/machines/machineAccessV1';
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
  const refuse = (errorCode: MachineAccessRefusalCode | 'machine_inventory_unavailable' | 'target_unavailable'
    | 'requester_account_material_unavailable' | 'machine_offline', details?: Readonly<{ machineId: string }>) => ({
    kind: 'refused' as const,
    execution: {
      ok: false as const,
      errorCode,
      error: errorCode,
      effectAttempted: false,
      ...(details ? { details } : {}),
      failureCause: projectActionFailureCauseV1({ code: errorCode }, 'dispatch.machine_selection', { allowUnknownErrorCode: true }),
    },
  });
  if (!input.machines) return refuse('machine_inventory_unavailable');
  const machine = input.machines.find(row => row.id === input.machineId);
  // Home deliberately gives hidden and missing rows the same exact-read result.
  if (!machine || !machine.access) return refuse('access_denied');
  if (machine.kind !== 'persistent' || machine.revokedAt !== null || machine.replacedByMachineId !== null) {
    return refuse('machine_unavailable');
  }
  if (machine.access.accessState !== 'ready') {
    return refuse(machine.access.reason ?? (machine.access.accessState === 'key_pending'
      ? 'recipient_key_pending' : 'machine_unavailable'));
  }
  if (!await input.isCurrent()) return refuse('target_unavailable');
  const foreign = machine.access.custodian.accountId !== input.accountId;
  if (!foreign && machine.access.resourceMode !== input.accountMode) return refuse('encryption_material_unavailable');
  if (foreign && ((input.authenticationKind !== 'account' && input.authenticationKind !== 'terminal')
    || input.authenticationKind === 'account' && input.authority === 'account_automation'
    || input.credentialProvenance === 'api_token') && !input.managedAdmission) return refuse('requester_account_material_unavailable');
  // Finite/deferred Actions can retain offline targets. A new Session needs a live Machine.
  if (input.actionId === 'session.spawn_new' && !machine.active) return refuse('machine_offline', { machineId: machine.id });
  return { kind: 'ready', machine, foreign };
}
