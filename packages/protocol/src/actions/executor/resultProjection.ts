import { isRpcError, readRpcErrorCode, RPC_ERROR_CODES } from '../../rpc/errors.js';
import { PublicProfileAccountScopeError } from './publicProfileActions.js';
import { RegistryFetchErrorV1, RegistrySourceStatusV1Schema } from '../../registries/registryListV1.js';
import { MemoryDocFailureV1 } from '../../prompts/library/promptLibraryActionOperations.js';
import { ArtifactOrganizationMutationFailureV1, ArtifactOrganizationMutationFailureDetailsV1Schema } from '../../prompts/library/promptFolderActionsV1.js';
import { PromptStackPreparationError } from '../../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';
import { SessionOrganizationContentUnavailableError } from '../../sessions/organization/content.js';
import { readRecord, hasOwn } from '../../inputs/inputRecords.js';
import { readSshCommandFailure, readRemoteEnrollmentCommandFailure } from '../../ssh/commandFailure.js';
import { ActionOperationFailureV1Schema, ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema } from '../operations/v1.js';
import { SessionListUnavailableQueryV1Schema } from '../../sessions/listing/query.js';
import { SessionControlErrorCodeSchema } from '../../sessions/control/contract.js';
import { SpawnSessionErrorCodeSchema } from '../../sessions/spawnSession.js';
import { ArtifactAccessErrorCodeV1Schema } from '../../artifacts/artifactAccessV1.js';
import { WorkflowOperationErrorCodeV1Schema } from '../../workflows/workflowProgressV1.js';
import { MemoryDecisionSourceErrorCodeV1Schema } from '../../prompts/library/memoryActionsV1.js';
import { SkillUnavailableReasonV1Schema } from '../../prompts/library/skills/skillLibraryItemV1.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../actionExecutionResult.js';
import { ExecutionRunSendResponseSchema, ExecutionRunStopResponseSchema, ExecutionRunTransportErrorCodeSchema } from '../../execution/runs/responseSchemas.js';
import type { ActionExecuteResult } from './types.js';
import { readActionFailureEnvelope, readFailureEnvelopeDetails } from './actionFailureEnvelope.js';
import { type ActionId } from '../actionIds.js';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunEnsureResponseSchema } from '../../execution/runs/index.js';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '../../execution/runs/streaming.js';
import { ExecutionRunCancelTurnResponseSchema } from '../../execution/runs/cancelTurn.js';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '../../sessions/creation/sessionSpawnNewResultV1.js';

const RPC_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(RPC_ERROR_CODES));

export function normalizeActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown }> {
  if (error instanceof PublicProfileAccountScopeError) return { errorCode: error.code, error: error.code };
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
  const managedRequest = ManagedControllerRequestFailureDetailsV1Schema.safeParse(rawDetails);
  if (managedRequest.success && (!managedRequest.data.code || rawCodes.includes(managedRequest.data.code))) {
    const code = managedRequest.data.code ?? rawCodes[0] ?? 'managed_controller_request_failed';
    return { errorCode: code, error: code, details: managedRequest.data };
  }
  const managedNative = ManagedNativeFailureDetailsV1Schema.safeParse(rawDetails);
  if (managedNative.success && rawCodes[0]) {
    return { errorCode: rawCodes[0], error: rawCodes[0], details: managedNative.data };
  }
  if (rawCodes[0] && readRecord(rawDetails).kind === 'managedBootstrap') {
    const failure = ActionOperationFailureV1Schema.safeParse({ errorCode: rawCodes[0], error: rawCodes[0], details: rawDetails });
    if (failure.success) return failure.data;
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
  const protocolCode = rawCodes.find((value) => (
    SessionControlErrorCodeSchema.safeParse(value).success
    || SpawnSessionErrorCodeSchema.safeParse(value).success
    || ArtifactAccessErrorCodeV1Schema.safeParse(value).success
    || WorkflowOperationErrorCodeV1Schema.safeParse(value).success
    || MemoryDecisionSourceErrorCodeV1Schema.safeParse(value).success
    || SkillUnavailableReasonV1Schema.safeParse(value).success
    || value === 'workspace_sync_update_required'
    // Host HTTP readers have already validated the strict authentication refusal.
    || value === 'credential_scope_denied'
    // A host-local delegation can be revoked before the decision is issued.
    || value === 'present_user_required'
    // The selected transport can lack an adapter for an admitted operation.
    || value === 'unsupported_action'
    || value === 'project_requester_home_unavailable'
    // Transport owners have already decided whether a mutation may have committed.
    || isActionOutcomeUnknownErrorCodeV1(value)
    || value === 'MACHINE_RPC_TIMEOUT'
    || value === 'cancelled'
    || value === 'version_mismatch'
    || value === 'approval_request_conflict'
    || value === 'prompt_bundle_invalid_kind'
    || value === 'connected_services_default_unavailable'
    || ExecutionRunTransportErrorCodeSchema.safeParse(value).success
  )) ?? '';
  const rpcErrorCode = readRpcErrorCode(error);
  const typedRpcErrorCode = rpcErrorCode && (isRpcError(error) || RPC_ERROR_CODE_SET.has(rpcErrorCode))
    ? rpcErrorCode
    : '';
  const normalizedCode = isActionOutcomeUnknownErrorCodeV1(protocolCode) ? 'outcome_unknown' : protocolCode || typedRpcErrorCode;
  const rawCode = rawCodes[0] ?? '';
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
      ...(details !== undefined ? { details } : {}),
    };
  }

  // Common network failures from axios/node.
  if (rawCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(rawCode)) {
    return {
      errorCode: 'server_unreachable',
      error: message || 'server_unreachable',
      ...(details !== undefined ? { details } : {}),
    };
  }

  return {
    errorCode: 'action_failed',
    error: message || 'action_failed',
    ...(details !== undefined ? { details } : {}),
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
