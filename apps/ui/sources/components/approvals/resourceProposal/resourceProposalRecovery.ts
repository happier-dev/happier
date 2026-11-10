import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { MachineStorageDeleteNowInputV1Schema, MachineStorageTrashMoveInputV1Schema, type PileApplyResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { MachineProcessesStartAgainResultV1Schema, type MachineProcessesActionResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { writeApprovalRequestArtifact } from '@/sync/ops/actions/approvalArtifactWriter';
import { Modal } from '@/modal';
import { t } from '@/text';
import { executeMachineProcessesActionV1, executeMachineProcessesStartAgainV1 } from '@/sync/domains/machines/processes/machineProcessesActions';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { machineStorageStore } from '@/sync/domains/machines/storage/machineStorageStore';
import { deleteMachineStorageNowViaAction } from '@/sync/domains/machines/storage/machineRpc';

import type { ResourceProposalModel } from './readResourceProposalApproval';
import { readResourceProposalProcessResult } from './resourceProposalPresentation';

export type ResourceProposalLocalRun =
  | Readonly<{ kind: 'trashed'; result: PileApplyResultV1 }>
  | Readonly<{ kind: 'stopped'; result: MachineProcessesActionResultV1 }>;

/** The same Action, invoked by the present person from the UI: a new invocation, re-checked by its executor. */
export async function runResourceProposalFromUi(
  model: ResourceProposalModel,
  input: Readonly<Record<string, unknown>>,
  serverId: string | null,
  retryReceipt?: Readonly<{ artifactId: string; approval: ApprovalRequestV2 }>,
): Promise<ResourceProposalLocalRun | null> {
  try {
    if (model.kind === 'storage') {
      if (!serverId) return null;
      const account = await captureLazyActionAccountContext(serverId);
      try {
        const result = model.storageMode === 'delete'
          ? await deleteMachineStorageNowViaAction({ ...MachineStorageDeleteNowInputV1Schema.parse(input),
            serverId: account.serverId, expectedAccountId: account.accountId })
          : await machineStorageStore.moveToTrash({ ...MachineStorageTrashMoveInputV1Schema.parse(input),
            serverId: account.serverId, expectedAccountId: account.accountId });
        if (!result.ok) return null;
        if (retryReceipt && result.value.mode === 'trash') {
          try {
            const full = await account.fetchArtifact(retryReceipt.artifactId, { fresh: true });
            const stored = full?.header && typeof full.body === 'string'
              ? approvalArtifactBodyMatchesHeaderV1(full.header, full.body) : null;
            if (stored?.family !== 'built_in' || stored.request.v !== 2
              || stored.request.executionOriginV1.requestId !== retryReceipt.approval.executionOriginV1.requestId) {
              throw new Error('approval_request_subject_mismatch');
            }
            const next = ApprovalRequestV2Schema.parse({ ...stored.request, updatedAtMs: Date.now(),
              storageRetryResults: [...(stored.request.storageRetryResults ?? []), result.value] });
            const written = await writeApprovalRequestArtifact({ artifactId: retryReceipt.artifactId, request: next,
              read: id => account.fetchArtifact(id, { fresh: true }),
              write: (basis, header, body) => account.updateArtifact(retryReceipt.artifactId, header, body, basis) });
            if (!written.ok) throw new Error(written.error);
          } catch {
            // The effect already settled. Keep its real local receipt/Undo and surface the failed history write.
            Modal.alert(t('common.error'), t('approvals.decisionError'));
          }
        }
        return { kind: 'trashed', result: result.value };
      } finally {
        account.dispose();
      }
    }
    if (!serverId) return null;
    const account = await captureLazyActionAccountContext(serverId);
    try {
      const actionId = model.actionId;
      if (actionId === 'machines.storage.trash.move' || actionId === 'machines.storage.deleteNow') return null;
      const parsedInput = MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[actionId].safeParse({ ...input, serverId });
      if (!parsedInput.success) return null;
      const outcome = await executeMachineProcessesActionV1(actionId, parsedInput.data, { serverId, expectedAccountId: account.accountId });
      const result = outcome.ok ? readResourceProposalProcessResult(model, outcome.result) : null;
      return result ? { kind: 'stopped', result } : null;
    } finally {
      account.dispose();
    }
  } catch {
    Modal.alert(t('common.error'), t('approvals.decisionError'));
    return null;
  }
}

/** Start again after a stop (AGW-8): the process owner's own Action and its launcher review. */
export async function startResourceProposalProcessAgain(machineId: string, ref: string, serverId: string): Promise<boolean> {
  try {
    const account = await captureLazyActionAccountContext(serverId);
    try {
      const outcome = await executeMachineProcessesStartAgainV1({ machineId, serverId, ref },
        { serverId, expectedAccountId: account.accountId },
        { runtimeActionExecute: createFrontDoorRuntimeActionExecutor() });
      if (!outcome.processAction.ok) return false;
      const parsed = MachineProcessesStartAgainResultV1Schema.safeParse(outcome.processAction.result);
      return outcome.serviceStartResponse !== undefined
        || (parsed.success && (parsed.data.status === 'started' || parsed.data.status === 'already_wakes_on_next_message'));
    } finally {
      account.dispose();
    }
  } catch {
    Modal.alert(t('common.error'), t('approvals.decisionError'));
    return false;
  }
}
