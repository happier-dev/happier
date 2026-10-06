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
  subscribeExternalSessionOperationRecords,
  type ExternalSessionOperationStoredEntry,
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
  const directoryForScope = async (scope: ActionOperationQueryScope) => await resolveExternalSessionOperationRecordsDirectory(
    deps.activeServerDir, 'activity', { activeServerDir: deps.activeServerDir, accountSubject: scope.accountId },
  );
  const read = async (scope: ActionOperationQueryScope, operationId: string) => await readExternalSessionOperationStoredEntry(
    await directoryForScope(scope), operationId,
  );
  return Object.freeze<ActionOperationDomainOwner>({
    actionIds: ACTION_IDS,
    async list(scope) {
      return (await listExternalSessionOperationStoredEntries(await directoryForScope(scope)))
        .flatMap((entry) => {
          const snapshot = projectExternalSessionActionOperation(entry, scope);
          return snapshot ? [snapshot] : [];
        });
    },
    async get(scope, operationId) {
      const entry = await read(scope, operationId);
      return entry ? projectExternalSessionActionOperation(entry, scope) : null;
    },
    async cancel(scope, operationId) {
      // Only the durable executor may decide or mutate cancellation. Retry its CAS when a progress commit races Stop.
      for (;;) {
        const entry = await read(scope, operationId);
        if (!entry) return null;
        const snapshot = projectExternalSessionActionOperation(entry, scope);
        if (!snapshot) return null;
        if (entry.kind === 'terminal_receipt' || isExternalSessionOperationTerminalStatusV1(entry.record.status)) return { kind: 'already_settled' as const };
        const record = entry.record;
        if (record.status === 'cancel_requested') return { kind: 'requested' as const };
        if (!canCancelExternalSessionOperationV1(record)) return { kind: 'unsupported' as const };
        const result = await deps.execute('sessions.external.operation.cancel', {
          sessionId: record.request.sessionId, operationId, revision: record.revision,
        });
        if (!result.ok) throw new Error(`external_session_activity_cancel_failed:${result.errorCode}`);
        const response = ExternalSessionOperationActionResponseV1Schema.parse(result.result);
        if (response.ok) return { kind: 'requested' as const };
        if (response.error.code === 'stale_revision') continue;
        if (response.error.code === 'not_allowed' || response.error.code === 'operation_conflict') return { kind: 'unsupported' as const };
        throw new Error(`external_session_activity_cancel_failed:${response.error.code}`);
      }
    },
    subscribe({ resolveScope, publishSnapshot }) {
      let disposed = false;
      const unsubscribe = subscribeExternalSessionOperationRecords((directory, record) => {
        void (async () => {
          const scope = await resolveScope();
          if (!scope || disposed || directory !== await directoryForScope(scope)) return;
          const snapshot = projectExternalSessionActionOperation({ kind: 'full_record', record }, scope);
          if (!disposed && snapshot) publishSnapshot(snapshot);
        })().catch((error) => logExternalSessionsInternalError('external_session.operation_activity_projection', error));
      });
      return () => { disposed = true; unsubscribe(); };
    },
  });
}
