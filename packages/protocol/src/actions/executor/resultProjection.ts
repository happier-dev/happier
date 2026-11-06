import { OpenProjectResultV1Schema } from '../../projects/openProjectV1.js';
import { projectActionExecuteFailure } from '../actionExecutionResult.js';
import { isRecord } from '../../inputs/inputRecords.js';
import { getActionSpec } from '../actionSpecs.js';
import { isPluginError } from '../../plugins/errors.js';
import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';
import { isRpcError } from '../../rpc/errors.js';
import { RegistryFetchErrorV1, RegistrySourceStatusV1Schema } from '../../registries/registryListV1.js';
import { MemoryDocFailureV1 } from '../../prompts/library/promptLibraryActionOperations.js';
import { ArtifactOrganizationMutationFailureV1, ArtifactOrganizationMutationFailureDetailsV1Schema } from '../../prompts/library/promptFolderActionsV1.js';
import { PromptStackPreparationError } from '../../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';
import { SessionOrganizationContentUnavailableError } from '../../sessions/organization/content.js';
import { readRecord, hasOwn } from '../../inputs/inputRecords.js';
import { readSshCommandFailure, readRemoteEnrollmentCommandFailure } from '../../ssh/commandFailure.js';
import { ActionOperationFailureV1Schema, ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema } from '../operations/v1.js';
import { SessionListUnavailableQueryV1Schema } from '../../sessions/listing/query.js';
import { ConnectedServicesDefaultUnavailableDetailsV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';
import { isActionOutcomeUnknownErrorCodeV1, ActionFailureCauseV1Schema,
  projectActionFailureCauseV1, readActionErrorCodeV1, type ActionFailureCauseV1 } from '../actionExecutionResult.js';
import { ExecutionRunSendResponseSchema, ExecutionRunStopResponseSchema } from '../../execution/runs/responseSchemas.js';
import type { ActionExecuteResult } from './types.js';
import { readActionFailureEnvelope, readFailureEnvelopeDetails } from './actionFailureEnvelope.js';
import { type ActionId } from '../actionIds.js';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunEnsureResponseSchema } from '../../execution/runs/index.js';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '../../execution/runs/streaming.js';
import { ExecutionRunCancelTurnResponseSchema } from '../../execution/runs/cancelTurn.js';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '../../sessions/creation/sessionSpawnNewResultV1.js';

export function normalizeActionExecutorThrownError(error: unknown, phase?: string): Readonly<{ errorCode: string; error: string; details?: unknown; failureCause: ActionFailureCauseV1; effectAttempted?: boolean }> {
  const failure = classifyActionExecutorThrownError(error);
  let carriedCause: unknown;
  try { carriedCause = isPluginError(error) ? error.data.failureCause : readRecord(error).failureCause; }
  catch { /* A diagnostic carrier accessor cannot replace the original Action failure. */ }
  const forwarded = ActionFailureCauseV1Schema.safeParse(carriedCause);
  return { ...failure, error: redactBugReportSensitiveText(failure.error),
    failureCause: forwarded.success ? forwarded.data : projectActionFailureCauseV1(error, phase) };
}

function classifyActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown; effectAttempted?: boolean }> {
  if (error instanceof RegistryFetchErrorV1) {
    const status = RegistrySourceStatusV1Schema.safeParse(error.status);
    if (status.success && status.data.state !== 'ok') {
      return { errorCode: status.data.state, error: status.data.state, details: { registryStatus: status.data } };
    }
  }
  if (error instanceof MemoryDocFailureV1) {
    return { errorCode: error.code, error: error.message,
      ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof ArtifactOrganizationMutationFailureV1) {
    return { errorCode: error.code, error: error.message,
      details: ArtifactOrganizationMutationFailureDetailsV1Schema.parse(error.details) };
  }
  if (error instanceof PromptStackPreparationError) {
    return { errorCode: error.code, error: error.message };
  }
  if (error instanceof SessionOrganizationContentUnavailableError) {
    return { errorCode: error.code, error: error.message };
  }
  const errorRecord = readRecord(error);
  if (errorRecord.code === 'action_account_scope_changed') {
    return { errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
  }
  const sshFailure = readSshCommandFailure(errorRecord.code, errorRecord.message);
  if (sshFailure) return { errorCode: sshFailure.code, error: sshFailure.message };
  const enrollmentFailure = readRemoteEnrollmentCommandFailure(errorRecord.code, errorRecord.message);
  if (enrollmentFailure) return { errorCode: enrollmentFailure.code, error: enrollmentFailure.message };
  const rawDetails = errorRecord.details;
  const details = rawDetails && typeof rawDetails === 'object'
    && Object.hasOwn(rawDetails, 'spawnResponse')
    && typeof (rawDetails as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (rawDetails as { spawnNonce: string }).spawnNonce.trim().length > 0
    ? { spawnNonce: (rawDetails as { spawnNonce: string }).spawnNonce.trim(), accepted: true as const }
    : undefined;
  const rawCodes = [errorRecord.code, errorRecord.errorCode]
    .map((value) => (typeof value === 'string' ? String(value).trim() : ''))
    .filter((value) => value.length > 0);
  if (rawCodes.includes('connected_services_default_unavailable')) {
    const defaultDetails = ConnectedServicesDefaultUnavailableDetailsV1Schema.safeParse(rawDetails);
    if (defaultDetails.success) return { errorCode: 'connected_services_default_unavailable',
      error: defaultDetails.data.reason, details: defaultDetails.data };
    return { errorCode: 'connected_services_default_unavailable', error: 'connected_services_default_unavailable' };
  }
  const managedRequest = ManagedControllerRequestFailureDetailsV1Schema.safeParse(rawDetails);
  if (managedRequest.success && (!managedRequest.data.code || rawCodes.includes(managedRequest.data.code))) {
    const code = managedRequest.data.code ?? rawCodes[0] ?? 'managed_controller_request_failed';
    return { errorCode: code, error: code, details: managedRequest.data };
  }
  if (ManagedControllerRequestFailureDetailsV1Schema.shape.kind.safeParse(readRecord(rawDetails).kind).success) {
    const code = rawCodes[0] ?? 'managed_controller_request_failed';
    return { errorCode: code, error: code };
  }
  const managedNative = ManagedNativeFailureDetailsV1Schema.safeParse(rawDetails);
  if (managedNative.success && rawCodes[0]) {
    return { errorCode: rawCodes[0], error: rawCodes[0], details: managedNative.data };
  }
  if (ManagedNativeFailureDetailsV1Schema.shape.kind.safeParse(readRecord(rawDetails).kind).success) {
    const code = rawCodes[0] ?? 'action_failed';
    return { errorCode: code, error: code };
  }
  if (rawCodes[0] && (readRecord(rawDetails).kind === 'managedBootstrap' || readRecord(rawDetails).kind === 'managedAgentIsolation')) {
    const failure = ActionOperationFailureV1Schema.safeParse({ errorCode: rawCodes[0], error: rawCodes[0], details: rawDetails });
    if (failure.success) {
      const details = failure.data.details;
      return details && 'kind' in details && details.kind === 'managedAgentIsolation' && details.phase === 'machines.agentIsolation.set'
        ? { ...failure.data, error: `Agent isolation requires a fresh review (reviewed metadata version ${details.expectedMetadataVersion}, current ${details.metadataVersion}). Review the Machine's Agent isolation settings before applying.` }
        : failure.data;
    }
    return { errorCode: rawCodes[0], error: rawCodes[0] };
  }
  // Closed native bootstrap reasons remain useful without a vendor error body.
  if (errorRecord.code === 'native_resource_unavailable' || errorRecord.code === 'native_action_failed'
    || errorRecord.code === 'native_ssh_host_key_unavailable' || errorRecord.code === 'host_key_evidence_mismatch'
    || errorRecord.code === 'invalid_trusted_host_key' || errorRecord.code === 'trusted_host_key_mismatch') {
    return { errorCode: errorRecord.code, error: errorRecord.code };
  }
  const sessionListUnavailable = SessionListUnavailableQueryV1Schema.safeParse(rawDetails);
  if (sessionListUnavailable.success && rawCodes.includes(sessionListUnavailable.data.code)) {
    return {
      errorCode: sessionListUnavailable.data.code,
      error: sessionListUnavailable.data.code,
      details: sessionListUnavailable.data,
    };
  }
  const protocolCode = readActionErrorCodeV1(error);
  const normalizedCode = isActionOutcomeUnknownErrorCodeV1(protocolCode) ? 'outcome_unknown'
    : protocolCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(protocolCode)
      ? 'server_unreachable' : protocolCode;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof errorRecord.message === 'string'
          ? String(errorRecord.message)
          : typeof errorRecord.errorMessage === 'string'
            ? String(errorRecord.errorMessage)
            : typeof errorRecord.error === 'string'
              ? String(errorRecord.error)
              : '';

  if (normalizedCode) {
    return {
      errorCode: normalizedCode,
      error: message || normalizedCode,
      ...((details ?? rawDetails) === undefined ? {} : { details: details ?? rawDetails }),
      ...(isRpcError(error) && typeof errorRecord.effectAttempted === 'boolean' ? { effectAttempted: errorRecord.effectAttempted } : {}),
    };
  }
  return {
    errorCode: 'action_failed',
    error: message || 'action_failed',
    ...(details ? { details } : {}),
  };
}

export function completeActionResult(
  result: unknown,
  options: Readonly<{ treatReturnedErrorEnvelopeAsFailure?: boolean }> = {},
): ActionExecuteResult {
  const failure = readActionFailureEnvelope(result, options);
  return failure ?? { ok: true, result };
}

/** Keep coordinator/RPC success envelopes internal to their host adapter. */
export function completeSessionHandoffActionResult(result: unknown): ActionExecuteResult {
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;

  const record = readRecord(result);
  if (record.ok === true && Object.prototype.hasOwnProperty.call(record, 'result')) {
    return completeActionResult(record.result);
  }
  if (record.ok === true) {
    const { ok: _ok, ...terminalResult } = record;
    return completeActionResult(terminalResult);
  }
  return completeActionResult(result);
}

/**
 * Execution-run services keep their RPC compatibility envelope internal. The
 * public Action boundary projects its payload or failure into the canonical
 * Action result shape; raw Action-shaped values still pass through unchanged.
 */
export function completeExecutionRunServiceActionResult(actionId: ActionId, result: unknown): ActionExecuteResult {
  const record = readRecord(result);
  if (record.ok === true && hasOwn(record, 'data')) {
    const data = record.data;
    switch (actionId) {
      case 'execution.run.send':
        return completeActionResult(ExecutionRunSendResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.ensure':
        return completeActionResult(ExecutionRunEnsureResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.ensure_or_start':
        return completeActionResult(ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.stream.start':
        return completeActionResult(ExecutionRunTurnStreamStartResponseSchema.parse(data));
      case 'execution.run.stream.read':
        return completeActionResult(ExecutionRunTurnStreamReadResponseSchema.parse(data));
      case 'execution.run.stream.cancel':
        return completeActionResult(ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.stop':
        return completeActionResult(ExecutionRunStopResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.cancel_turn':
        return completeActionResult(ExecutionRunCancelTurnResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.action':
        return completeActionResult(ExecutionRunActionResponseSchema.parse({ ok: true, ...readRecord(data) }));
      default:
        return completeActionResult(data);
    }
  }

  if (record.ok === false && typeof record.code === 'string' && record.code.trim().length > 0) {
    const errorCode = record.code.trim();
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const details = readFailureEnvelopeDetails(record);
    return {
      ok: false,
      errorCode,
      error: message || errorCode,
      ...(details !== undefined ? { details } : {}),
    };
  }

  return completeActionResult(result);
}

export function completeSpawnActionResult(result: unknown): ActionExecuteResult {
  const spawn = SessionSpawnNewResultV1Schema.safeParse(result);
  return completeActionResult(spawn.success ? projectSessionSpawnNewActionResultV1(spawn.data) : result,
    { treatReturnedErrorEnvelopeAsFailure: true });
}

export function settleActionOutput(actionId: ActionId, result: ActionExecuteResult, requestId?: string): ActionExecuteResult {
  const withCredentialUses = (settled: ActionExecuteResult): ActionExecuteResult => {
    const projected = settled.ok ? settled : projectActionExecuteFailure(settled, requestId);
    return result.operationCredentialUses?.length ? { ...projected, operationCredentialUses: result.operationCredentialUses } : projected;
  };
  if (!result.ok) {
    if (actionId === 'projects.open' && (result.errorCode === 'outcome_unknown'
      || result.errorCode === 'invalid_action_output' || result.errorCode === 'result_too_large')) {
      return withCredentialUses(completeUnknownProjectOpenResult(result.details));
    }
    return withCredentialUses(result);
  }
  if (isDeferredApprovalResult(result)) return result;
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) return result;
  const invalidOutput = (): ActionExecuteResult => actionId === 'projects.open'
    ? completeUnknownProjectOpenResult()
    : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  try {
    const output = outputSchema.safeParse(result.result);
    return withCredentialUses(output.success ? { ok: true, result: output.data } : invalidOutput());
  } catch {
    return withCredentialUses(invalidOutput());
  }
}

function completeUnknownProjectOpenResult(details?: unknown): ActionExecuteResult {
  const operationId = readRecord(details).operationId;
  const unknown = OpenProjectResultV1Schema.safeParse({ kind: 'outcomeUnknown',
    ...(operationId === undefined ? {} : { operationId }) });
  return { ok: true, result: unknown.success ? unknown.data : { kind: 'outcomeUnknown' } };
}

export function isDeferredApprovalResult(result: ActionExecuteResult): boolean {
  return result.ok && isRecord(result.result) && result.result.kind === 'approval_request_created';
}
