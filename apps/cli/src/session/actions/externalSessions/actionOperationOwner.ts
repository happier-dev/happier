import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { ExternalSessionOperationActionResponseV1Schema } from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';
import { canCancelExternalSessionOperationV1, isExternalSessionOperationTerminalStatusV1 } from '@happier-dev/protocol/sessions/external/operationV1';
import type { ExternalSessionOperationRecordV1 } from '@happier-dev/protocol';
import type { ActionOperationDomainOwner, ActionOperationQueryScope } from '@/daemon/actionOperations/actionOperationTypes';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import {
  listExternalSessionOperationStoredEntries,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationRecordsDirectory,
  captureExternalSessionOperationAccountAdmission,
  ExternalSessionOperationRecordReadError,
  subscribeExternalSessionOperationRecords,
  type ExternalSessionOperationStoredEntry,
  type ExternalSessionOperationAccountAdmission,
} from './operationRecordStore';
import { logExternalSessionsInternalError } from './responseErrors';

const ACTION_IDS = ['sessions.external.materialize.start', 'sessions.external.takeover.start'] as const;

function labelForStatus(status: ExternalSessionOperationRecordV1['status'], phase: string, errorCode?: string): string {
  switch (status) {
    case 'awaiting_user_resume': return 'Needs resume';
    case 'cancel_requested': return 'Cancelling';
    case 'failed': return `Needs retry${errorCode ? `: ${errorCode}` : ''}`;
    case 'reconciliation_required': return 'Needs review';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'discarded': return 'Discarded';
    default: return phase.replaceAll('_', ' ');
  }
}

/** Project only public lifecycle facts; private source paths, diagnostics and errors never enter the activity stream. */
export function projectExternalSessionActionOperation(
  entry: ExternalSessionOperationStoredEntry,
  scope: ActionOperationQueryScope,
): ActionOperationSnapshotV1 | null {
  const record = entry.kind === 'full_record' ? entry.record : null;
  const receipt = entry.kind === 'terminal_receipt' ? entry.receipt : null;
  const sessionId = record?.request.sessionId ?? receipt!.reference.sessionId;
  if (scope.sessionId && scope.sessionId !== sessionId) return null;
  if (record && record.request.source.machineId !== scope.machineId) return null;
  const status = record?.status ?? receipt!.presentation.status;
  const kind = record?.request.plan ?? receipt!.presentation.kind;
  const terminal = isExternalSessionOperationTerminalStatusV1(status);
  // A compact receipt retains the terminal observation, not the earlier private lifecycle timestamps.
  const createdAt = record?.createdAtMs ?? receipt!.terminalAtMs;
  const updatedAt = record?.updatedAtMs ?? receipt!.terminalAtMs;
  const state = status === 'completed' ? 'succeeded' : terminal ? 'cancelled' : 'running';
  const phase = terminal ? status : status === 'cancel_requested' ? 'cancelling'
    : ['awaiting_user_resume', 'failed', 'reconciliation_required'].includes(status) ? status
    : record?.phase ?? receipt!.presentation.phase;
  const label = labelForStatus(status, phase, record?.error?.code);
  const total = record ? Math.max(record.checkpoint.totalItemEstimate ?? record.checkpoint.stagedItemCount, record.checkpoint.importedItemCount) : 0;
  const progress = record && status === 'running' && record.phase === 'importing' && total > 0
    ? { kind: 'determinate' as const, current: record.checkpoint.importedItemCount, total, label }
    : { kind: 'phase' as const, phase, label };
  return ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: record?.operationId ?? receipt!.reference.operationId,
    // External revisions are zero-based; the shared wire requires positive revisions. No new revision clock.
    revision: (record?.revision ?? receipt!.reference.revision) + 1,
    actionId: kind === 'materialize' ? ACTION_IDS[0] : ACTION_IDS[1],
    state, scope: { accountId: scope.accountId, machineId: scope.machineId, sessionId },
    title: kind === 'materialize' ? 'Import external session' : 'Take over external session',
    createdAt, startedAt: createdAt, ...(terminal ? { settledAt: updatedAt } : {}), progress,
    cancellation: record && status !== 'cancel_requested' && canCancelExternalSessionOperationV1(record) ? 'supported' : 'unsupported',
  });
}

export function createExternalSessionActionOperationOwner(deps: Readonly<{
  activeServerDir: string;
  execute: RpcActionExecutor['execute'];
}>): ActionOperationDomainOwner {
  const admissionForScope = async (scope: ActionOperationQueryScope, captured?: ExternalSessionOperationAccountAdmission) => {
    const admission = captured ?? await captureExternalSessionOperationAccountAdmission(deps.activeServerDir);
    if (!admission) throw new ExternalSessionOperationRecordReadError('account_scope_unavailable', 'activity');
    const admitted = admission?.accountScope;
    // This durable domain belongs to the installed Account. Foreign requesters
    // may still inspect their host-owned Browser and other in-memory operations.
    if (admitted && admitted.accountSubject !== scope.accountId) return null;
    const directory = await resolveExternalSessionOperationRecordsDirectory(
      deps.activeServerDir, 'activity', { activeServerDir: deps.activeServerDir, accountSubject: scope.accountId },
    );
    return { directory, admission };
  };
  const read = async (scope: ActionOperationQueryScope, operationId: string, captured?: ExternalSessionOperationAccountAdmission) => {
    const admitted = await admissionForScope(scope, captured);
    return admitted ? { entry: await readExternalSessionOperationStoredEntry(admitted.directory, operationId), admission: admitted.admission } : null;
  };
  return Object.freeze<ActionOperationDomainOwner>({
    actionIds: ACTION_IDS,
    async list(scope) {
      const admitted = await admissionForScope(scope);
      if (!admitted) return [];
      return (await listExternalSessionOperationStoredEntries(admitted.directory))
        .flatMap((entry) => {
          const snapshot = projectExternalSessionActionOperation(entry, scope);
          return snapshot ? [snapshot] : [];
        });
    },
    async get(scope, operationId) {
      const entry = (await read(scope, operationId))?.entry;
      return entry ? projectExternalSessionActionOperation(entry, scope) : null;
    },
    async cancel(scope, operationId, context) {
      const admitted = await read(scope, operationId, context?.externalSessionOperationAdmission);
      if (!admitted) return null;
      const entry = admitted.entry;
      if (!entry) return null;
      const snapshot = projectExternalSessionActionOperation(entry, scope);
      if (!snapshot) return null;
      if (entry.kind === 'terminal_receipt' || isExternalSessionOperationTerminalStatusV1(entry.record.status)) return { kind: 'already_settled' as const };
      const record = entry.record;
      if (record.status === 'cancel_requested') return { kind: 'requested' as const };
      const result = await deps.execute('sessions.external.operation.cancel', {
        sessionId: record.request.sessionId, operationId, revision: record.revision,
      }, { ...context, ...(admitted.admission ? { externalSessionOperationAdmission: admitted.admission } : {}) });
      if (!result.ok) throw new Error(`external_session_activity_cancel_failed:${result.errorCode}`);
      const response = ExternalSessionOperationActionResponseV1Schema.parse(result.result);
      if (response.ok) return { kind: 'requested' as const };
      if (response.error.code === 'operation_not_found') return null;
      if (response.error.code === 'not_allowed' || response.error.code === 'operation_conflict') return { kind: 'unsupported' as const };
      throw new Error(`external_session_activity_cancel_failed:${response.error.code}`);
    },
    subscribe({ resolveScope, publishSnapshot }) {
      let disposed = false;
      const unsubscribe = subscribeExternalSessionOperationRecords((directory, record) => {
        void (async () => {
          const scope = await resolveScope();
          if (!scope || disposed || directory !== (await admissionForScope(scope))?.directory) return;
          const snapshot = projectExternalSessionActionOperation({ kind: 'full_record', record }, scope);
          if (!disposed && snapshot) publishSnapshot(snapshot);
        })().catch((error) => logExternalSessionsInternalError('external_session.operation_activity_projection', error));
      });
      return () => { disposed = true; unsubscribe(); };
    },
  });
}
