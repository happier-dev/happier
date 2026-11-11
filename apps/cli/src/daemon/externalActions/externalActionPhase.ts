import { logger } from '@/ui/logger';
import { timeApprovalPhase } from './webLatencyTrace';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionStartDiagnosticV1 } from '@happier-dev/protocol/actions/executor/actionStartDiagnostics';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseActionExecuteFailure, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginHttpTraceDiagnostic } from '@happier-dev/cli-common/plugins/http';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { CurrentIntentMismatchV1 } from '@happier-dev/protocol/actions/executor/approvalReview';

const innerStageContext = new AsyncLocalStorage<Readonly<{ actionId: string; rootRequestId: string }>>();

export type ExternalActionInnerDiagnostic = Readonly<PluginHttpTraceDiagnostic & {
  artifactId?: string;
  approvalStatus?: TargetActionApprovalRequestV1['status'] | null;
  invocationId?: string;
  claimAttemptId?: string;
  claimOccurrenceId?: string;
  claimProducerPid?: number;
  claimProducerKind?: 'daemon' | 'cli';
  claimAbsent?: boolean;
  declarationChanged?: boolean;
  occurrenceChanged?: boolean;
  accountChanged?: boolean;
  availabilityChanged?: boolean;
  collectionId?: string;
  collectionPreparationTriggerKind?: 'declaration-publication' | 'collection-operation' | 'explicit-candidate';
}>;

/** File-only refusal categories reuse the active request correlation, never its operands. */
export function logExternalActionCurrentIntentMismatch(field: CurrentIntentMismatchV1['field'],
  diagnostic?: Readonly<{ lookupBranch: 'account_confirmation'; hasConfirmation: boolean; hasApproval: boolean }>): void {
  try { logger.warnLocalFile('[PluginAction] Current intent refused', {
    ...innerStageContext.getStore(), code: 'plugin_action_current_intent_mismatch', field, ...diagnostic,
  }); } catch { /* File diagnostics cannot change admission. */ }
}

/** Host-only phase facts; never pass plugin input, results, URLs or thrown values. */
export function traceExternalActionInnerStage(stage: string,
  diagnostic: ExternalActionInnerDiagnostic & Readonly<{ elapsedMs?: number }> = {}): void {
  if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return;
  try {
    logger.warnLocalFile('[external-action-stage]', {
      actionId: 'action.invoke', ...innerStageContext.getStore(), stage, ...diagnostic,
    });
  } catch { /* Diagnostic failure cannot change execution. */ }
}

export async function runTracedExternalActionInnerStage<T>(stage: string, operation: () => T | Promise<T>,
  diagnostic: ExternalActionInnerDiagnostic = {}): Promise<T> {
  if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await operation();
  const started = performance.now();
  traceExternalActionInnerStage(`${stage}.begin`, diagnostic);
  try { return await operation(); }
  finally { traceExternalActionInnerStage(`${stage}.end`, { ...diagnostic, elapsedMs: performance.now() - started }); }
}

function isUuidDiagnosticRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
}

/** Ordinary CLI input uses an opaque UUID. Authored request ids can contain private text. */
export function readSessionInputAdmissionDiagnostic(input: Readonly<{
  actionId: unknown; requestId: unknown; accountEncryptionMode?: 'plain' | 'e2ee';
}>) {
  if (input.actionId !== 'session.message.send' || !isUuidDiagnosticRequestId(input.requestId)) return undefined;
  return { requestId: input.requestId, actionId: 'session.message.send', accountEncryptionMode: input.accountEncryptionMode };
}

function isTracedRequest(actionId: unknown, rootRequestId: unknown): boolean {
  const validRequestId = ExternalActionRequestIdV1Schema.safeParse(rootRequestId).success;
  return validRequestId && (actionId === 'session.spawn_new'
    || (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive'
      || actionId === 'session.status.get' || actionId === 'plugins.list' || actionId === 'action.invoke'
      || process.env.HAPPIER_WEB_LATENCY_TRACE === '1'
        && (actionId === 'approval.request.decide' || actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
          || actionId === 'projects.inspect' || actionId === 'localServices.launcher.start'
          || actionId === 'projects.worker.status' || actionId === 'projects.service.relocate'
          || actionId === 'machines.provisioners.list' || actionId === 'machines.provisioners.check' || actionId === 'machines.provisioners.options'))
      && isUuidDiagnosticRequestId(rootRequestId));
}

/** Same UUID-qualified, content-free trace for host and contributed Action work. */
export async function runTracedExternalActionStage<T>(actionId: string, rootRequestId: unknown, stage: string,
  operation: () => T | Promise<T>): Promise<T> {
  // Socket RPC owns this prefix; retain its UUID so completion records join.
  const requestId = typeof rootRequestId === 'string' ? rootRequestId.replace(/^rpc_/u, '') : rootRequestId;
  traceExternalActionStage(actionId, requestId, `${stage}.begin`);
  try {
    return await (process.env.HAPPIER_WEB_LATENCY_TRACE === '1' && typeof requestId === 'string'
      && isTracedRequest(actionId, requestId)
      ? innerStageContext.run({ actionId, rootRequestId: requestId }, () => timeApprovalPhase(`approval.${stage}`, operation))
      : timeApprovalPhase(`approval.${stage}`, operation));
  }
  finally { traceExternalActionStage(actionId, requestId, `${stage}.end`); }
}

/** Correlates diagnosed admission paths without caller content. */
export function traceExternalActionStage(actionId: unknown, rootRequestId: unknown, stage: string, transportRequestId?: string,
  diagnostic?: Pick<ActionStartDiagnosticV1, 'phase' | 'elapsedMs'>): void {
  if (!isTracedRequest(actionId, rootRequestId)) return;
  try {
    const diagnosticTransportRequestId = transportRequestId?.replace(/^rpc_/u, '');
    logger.warnLocalFile('[external-action-stage]', { actionId, rootRequestId, stage,
      ...(diagnostic ? { phase: diagnostic.phase,
        ...(diagnostic.elapsedMs !== undefined ? { elapsedMs: diagnostic.elapsedMs } : {}) } : {}),
      ...(isUuidDiagnosticRequestId(diagnosticTransportRequestId)
        ? { transportRequestId: diagnosticTransportRequestId } : {}) });
  } catch { /* Diagnostics cannot change the Action outcome. */ }
}

export function createExternalActionStartDiagnosticRecorder(actionId: unknown, rootRequestId: unknown,
  machineId: string, transportRequestId?: string): ((event: ActionStartDiagnosticV1) => void) | undefined {
  if (!isTracedRequest(actionId, rootRequestId)) return undefined;
  return event => {
    traceExternalActionStage(actionId, rootRequestId, 'action_execution.phase', transportRequestId,
      { phase: event.phase, ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}) });
    if (event.refusalReason) refuseExternalActionPhase(event.phase, machineId, undefined, {
      requestId: String(rootRequestId), refusalBranch: event.refusalReason,
    });
  };
}

export type ExternalActionPhaseFailure = Readonly<{
  ok: false;
  phase: string;
  errorClass: string;
  message: string;
  executionFailure?: ActionExecuteFailure & Readonly<{ errorCode: 'project_requester_home_unavailable' | 'internal_error' | 'credential_scope_denied' | 'invalid_token' }>;
}>;

/** Private diagnostics must not serialize a thrown value, even a Zod or HTTP Error. */
export function refuseExternalActionPhase(phase: string, machineId: string | undefined, error?: unknown,
  witness?: Readonly<{ requestId?: string; actionId?: string; refusalBranch?: string; httpStatus?: number;
    accountEncryptionMode?: 'plain' | 'e2ee'; observedAccountEncryptionMode?: 'plain' | 'e2ee'; envelopeVersion?: 1 | 2 }>): ExternalActionPhaseFailure {
  const diagnostic = error === undefined ? undefined : readUnexpectedActionErrorDiagnosticV1(error);
  const errorClass = diagnostic?.errorClass ?? 'PhaseRefused';
  let message = error === undefined ? 'External Action phase refused' : 'External Action phase threw (details redacted)';
  // Preserve the useful Mini-migration discriminator without retaining an
  // arbitrary expression, path, credential or value from a runtime message.
  try {
    if (error instanceof TypeError) {
      const method = /\.(optional|nullable|extend|merge|partial|required|passthrough|strict|pick|omit|refine|transform|default) is not a function$/u.exec(error.message)?.[1];
      if (method) message = `Schema .${method} is not a function`;
    }
  } catch { /* Thrown values can have hostile prototype or message accessors. */ }
  const typedFailure = parseActionExecuteFailure(error);
  const executionFailure: ExternalActionPhaseFailure['executionFailure'] = isPluginError(error) && error.code === 'project_requester_home_unavailable'
    ? { ok: false, errorCode: error.code, error: error.code }
    : typedFailure && (typedFailure.errorCode === 'credential_scope_denied' || typedFailure.errorCode === 'invalid_token')
      ? { ...typedFailure, errorCode: typedFailure.errorCode }
    : typedFailure?.errorCode === 'internal_error' && typedFailure.failureCause
      ? { ok: false, errorCode: 'internal_error', error: 'internal_error', failureCause: typedFailure.failureCause }
      : undefined;
  const failure = { ok: false as const, phase, errorClass, message,
    ...(executionFailure ? { executionFailure } : {}) };
  // File-only: no terminal output or remote diagnostic payload. Logging cannot
  // change the existing public refusal if the filesystem is unavailable.
  try { logger.warnLocalFile('[external-action-phase]', { ...(machineId !== undefined ? { machineId } : {}), phase, errorClass, message,
    ...diagnostic,
    ...(witness?.httpStatus !== undefined ? { httpStatus: witness.httpStatus } : {}),
    ...(witness?.actionId ? { actionId: witness.actionId } : {}),
    ...(witness?.requestId ? { requestId: witness.requestId } : {}),
    ...(witness?.accountEncryptionMode ? { accountEncryptionMode: witness.accountEncryptionMode } : {}),
    ...(witness?.observedAccountEncryptionMode ? { observedAccountEncryptionMode: witness.observedAccountEncryptionMode } : {}),
    ...(witness?.envelopeVersion ? { envelopeVersion: witness.envelopeVersion } : {}),
    ...(witness?.refusalBranch ? { refusalBranch: witness.refusalBranch } : {}) }); } catch { /* Best effort. */ }
  return failure;
}

/** Keep a masked boundary failure typed until its owner maps it to the public result. */
export async function runExternalActionPhase<T>(phase: string, machineId: string, operation: () => T | Promise<T>): Promise<
  Readonly<{ ok: true; value: NonNullable<T> }> | ExternalActionPhaseFailure
> {
  try {
    const value = await timeApprovalPhase(`approval.external.${phase}`, operation);
    return value === null || value === undefined || value === false
      ? refuseExternalActionPhase(phase, machineId)
      : { ok: true, value };
  } catch (error) { return refuseExternalActionPhase(phase, machineId, error); }
}
