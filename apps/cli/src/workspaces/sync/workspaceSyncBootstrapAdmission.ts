import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';


/** Only the incumbent new-operation prerequisite may produce this refusal, before Sync effects. */
export class WorkspaceSyncInitialPreparationRefusal extends Error {
  readonly code: string | undefined;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Workspace Sync preparation is unavailable', { cause });
    this.name = 'WorkspaceSyncInitialPreparationRefusal';
    this.code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  }
}

/** Personal Machine admission reaches the incumbent durable owner; borrowed requester transport stays finite. */
export function assertWorkspaceSyncRequesterBootstrapSupported(input: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  admission?: SocketRpcMachineAdmissionContextV1;
  /** Installed physical daemon Account, derived from its own credentials. */
  receivingAccountId?: string | null;
  ownerKind: 'copy_once' | 'relationship';
  targetReplacement?: boolean;
  materializesRemoteSource?: boolean;
}>): void {
  // Ingress already admitted this operation. Consume its custody fact without
  // re-authorizing or discarding the original requester. SOURCE may be a
  // different Machine from the selected TARGET; the physical daemon must also belong to this Account.
  const accountId = input.authorization?.binding.accountId;
  if (input.ownerKind === 'relationship' && accountId
    && input.authorization?.binding.custodianAccountId === accountId
    && input.admission?.actorAccountId === accountId
    && input.admission.custodianAccountId === accountId && input.admission.role === 'manage') {
    if (input.receivingAccountId !== accountId) {
      throw Object.assign(new Error('The receiving daemon cannot own this Account workspace Sync'), { code: 'machine_access_denied' });
    }
    return;
  }
  // LW-01/LW-04 and OPEN-1 keep relationship effects on the durable owner; unsupported finite-copy effects cannot borrow that owner.
  if (input.authorization && (input.ownerKind !== 'copy_once'
    || input.targetReplacement || input.materializesRemoteSource)) {
    throw Object.assign(new Error('The original requester bootstrap effect owner is unavailable'), {
      code: 'workspace_sync_update_required',
    });
  }
}
