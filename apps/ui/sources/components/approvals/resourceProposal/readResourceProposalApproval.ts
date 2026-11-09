import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  MachineProcessesStopInputV1Schema,
  MachineProcessesKillInputV1Schema,
  MachineProcessesCleanUpInputV1Schema,
  type ProcessOwnerRefV1,
  type MachineProcessesStopInputV1,
  type MachineProcessesKillInputV1,
  type MachineProcessesCleanUpInputV1,
  type MachineProcessTargetV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import {
  MachineStorageTrashMoveInputV1Schema,
  MachineStorageDeleteNowInputV1Schema,
  type MachineStorageTrashMoveInputV1,
  type MachineStorageDeleteNowInputV1,
  type StorageItemV1,
  type StorageReasonV1,
} from '@happier-dev/protocol/storage/storageV1';

export type ResourceProposalVerdict = StorageItemV1['verdict'];

export const RESOURCE_PROPOSAL_ACTION_IDS = [
  'machines.storage.trash.move', 'machines.storage.deleteNow', 'machines.processes.stop', 'machines.processes.kill', 'machines.processes.leftBehind.cleanUp',
] as const;

/** One requested item: what the agent claimed when it proposed, and the admitted operand itself. */
export type ResourceProposalItem = Readonly<{
  key: string;
  /** Storage: the item's path; processes: the identity-pinned ref. */
  path: string;
  claimedVerdict: ResourceProposalVerdict;
  reason: StorageReasonV1 | null;
  owner: ProcessOwnerRefV1 | null;
  /** The exact admitted item; narrowing may only refresh its `expect`. */
  operand: Readonly<Record<string, unknown>>;
}>;

export type ResourceProposalModel = Readonly<{
  kind: 'storage' | 'processes';
  storageMode: 'trash' | 'delete' | null;
  actionId: typeof RESOURCE_PROPOSAL_ACTION_IDS[number];
  machineId: string;
  serverId: string | null;
  items: readonly ResourceProposalItem[];
  /** Items the agent looked at and left out (Keep, Forbidden), listed so the person knows they exist. */
  notIncluded: readonly StorageItemV1[];
  goalBytes: number | null;
  /** The in-session disk-full fix (R37): the request empties the Trash and retries. */
  emptyAfter: boolean;
  retry: boolean;
  args: Readonly<Record<string, unknown>>;
}>;

function readStorage(
  args: MachineStorageTrashMoveInputV1 | MachineStorageDeleteNowInputV1,
  actionId: 'machines.storage.trash.move' | 'machines.storage.deleteNow',
): ResourceProposalModel {
  return {
    kind: 'storage',
    storageMode: actionId === 'machines.storage.deleteNow' ? 'delete' : 'trash',
    actionId,
    machineId: args.machineId,
    serverId: args.serverId ?? null,
    items: args.items.map((item) => ({
      key: item.ref.itemId,
      path: item.ref.path,
      claimedVerdict: 'claimedVerdict' in item ? item.claimedVerdict : 'check',
      reason: 'reason' in item ? item.reason ?? null : null,
      owner: null,
      operand: item,
    })),
    notIncluded: 'notIncluded' in args ? args.notIncluded ?? [] : [],
    goalBytes: 'goalBytes' in args ? args.goalBytes ?? null : null,
    emptyAfter: 'emptyAfter' in args && args.emptyAfter === true,
    retry: 'retry' in args && args.retry !== undefined,
    args,
  };
}

function readProcesses(
  args: MachineProcessesStopInputV1 | MachineProcessesKillInputV1 | MachineProcessesCleanUpInputV1,
  actionId: Exclude<ResourceProposalModel['actionId'], 'machines.storage.trash.move' | 'machines.storage.deleteNow'>,
): ResourceProposalModel {
  const targets: readonly MachineProcessTargetV1[] = 'targets' in args
    ? args.targets : args.refs.map(ref => ({ ref, expect: { level: 'left_behind' } }));
  return {
    kind: 'processes',
    storageMode: null,
    actionId,
    machineId: args.machineId,
    serverId: args.serverId ?? null,
    items: targets.map((target) => ({
      key: target.ref,
      path: target.ref,
      // Proven work starts again on demand; anything less certain is the person's to tick.
      claimedVerdict: target.expect.level === 'proven' || target.expect.level === 'left_behind' ? 'safe' : 'caution',
      reason: null,
      owner: target.expect.owner ?? null,
      operand: 'targets' in args ? target : { ref: target.ref },
    })),
    notIncluded: [],
    goalBytes: null,
    emptyAfter: false,
    retry: false,
    args,
  };
}

/**
 * The proposal card's reader (plan 60 AGW-6): an approval of a resource set Action is a proposal.
 * Pure: it reads the immutable admitted arguments and never decides anything about approval.
 */
export function readResourceProposalApproval(
  approval: Pick<ApprovalRequest, 'actionId' | 'actionArgs'>,
): ResourceProposalModel | null {
  if (approval.actionId === 'machines.storage.trash.move') {
    const parsed = MachineStorageTrashMoveInputV1Schema.safeParse(
      approval.actionArgs,
    );
    return parsed.success ? readStorage(parsed.data, approval.actionId) : null;
  }
  if (approval.actionId === 'machines.storage.deleteNow') {
    const parsed = MachineStorageDeleteNowInputV1Schema.safeParse(approval.actionArgs);
    return parsed.success ? readStorage(parsed.data, approval.actionId) : null;
  }
  if (approval.actionId === 'machines.processes.stop') {
    const parsed = MachineProcessesStopInputV1Schema.safeParse(
      approval.actionArgs,
    );
    return parsed.success ? readProcesses(parsed.data, approval.actionId) : null;
  }
  if (approval.actionId === 'machines.processes.kill') {
    const parsed = MachineProcessesKillInputV1Schema.safeParse(approval.actionArgs);
    return parsed.success ? readProcesses(parsed.data, approval.actionId) : null;
  }
  if (approval.actionId === 'machines.processes.leftBehind.cleanUp') {
    const parsed = MachineProcessesCleanUpInputV1Schema.safeParse(approval.actionArgs);
    return parsed.success ? readProcesses(parsed.data, approval.actionId) : null;
  }
  return null;
}

/** A decided proposal stays in the transcript as its receipt or its declined line (AGW-8). */
export function presentsSettledResourceProposal(approval: Pick<ApprovalRequest, 'actionId' | 'actionArgs'>): boolean {
  return readResourceProposalApproval(approval) !== null;
}
