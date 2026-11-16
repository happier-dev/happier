import type { core } from 'zod/mini';
import { isRpcError } from '../../rpc/errors.js';
import { isPluginError } from '../../plugins/errors.js';
import { readPluginActionError, readPluginActionFailureAuthorPayload } from '../../plugins/actions/invocation.js';
import { ApprovalRequestConflict, ApprovalRequestInvalid } from '../../approvals/creation.js';
import { RegistryFetchErrorV1, RegistrySourceStatusV1Schema } from '../../registries/registryListV1.js';
import { readRegistrySourceUrlErrorCodeV1 } from '../../registries/registryRpcV1.js';
import { MemoryDocFailureV1 } from '../../prompts/library/promptLibraryActionOperations.js';
import { ArtifactOrganizationMutationFailureV1, ArtifactOrganizationMutationFailureDetailsV1Schema } from '../../prompts/library/promptFolderActionsV1.js';
import { PromptStackPreparationError } from '../../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';
import { SessionOrganizationContentUnavailableError } from '../../sessions/organization/content.js';
import { ActionCatalogUnavailableError } from '../actionCatalog.js';
import { readRecord, hasOwn, isRecord } from '../../inputs/inputRecords.js';
import { readSshCommandFailure, readRemoteEnrollmentCommandFailure, readHomeAuthorityMismatchFailure } from '../../ssh/commandFailure.js';
import { ActionOperationFailureV1Schema, ManagedAgentStartFailureDetailsV1Schema, ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema, ManagedGuestHomeFailureDetailsV1Schema } from '../operations/v1.js';
import { SessionListUnavailableQueryV1Schema } from '../../sessions/listing/query.js';
import { ConnectedServicesDefaultUnavailableDetailsV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';
import { ActionOperationAcceptedResultSchema, isActionOutcomeUnknownErrorCodeV1, parseActionExecuteFailure, projectActionExecuteFailure, readActionFailureCauseV1,
  projectActionFailureCauseV1, readActionErrorCodeV1, readUnexpectedActionErrorDiagnosticV1, type ActionFailureCauseV1, type ActionExecuteFailure } from '../actionExecutionResult.js';
import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';
import { getActionSpec } from '../actionSpecs.js';
import { OpenProjectResultV1Schema } from '../../projects/openProjectV1.js';
import { ExecutionRunSendResponseSchema, ExecutionRunStopResponseSchema } from '../../execution/runs/responseSchemas.js';
import type { ActionExecuteResult } from './types.js';
import { readActionFailureEnvelope, readFailureEnvelopeDetails, readMachineActionRpcResult } from './actionFailureEnvelope.js';
import { type ActionId } from '../actionIds.js';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunEnsureResponseSchema } from '../../execution/runs/index.js';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '../../execution/runs/streaming.js';
import { ExecutionRunCancelTurnResponseSchema } from '../../execution/runs/cancelTurn.js';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '../../sessions/creation/sessionSpawnNewResultV1.js';

import { readActionOutputDiagnostic, invalidActionOutputFailure, carryActionFailureDiagnostic } from './actionFailureDiagnostic.js';
import type { ActionOutputDiagnostic } from './actionFailureDiagnostic.js';
export { readActionOutputDiagnostic, invalidActionOutputFailure, withActionFailureDiagnostic, carryActionFailureDiagnostic } from './actionFailureDiagnostic.js';
export type { ActionOutputDiagnostic, ActionFailureDiagnosticInput } from './actionFailureDiagnostic.js';

export function isDeferredApprovalResult(result: ActionExecuteResult): boolean {
  return result.ok && isRecord(result.result) && result.result.kind === 'approval_request_created';
}

/** A lost or unrepresentable Open receipt cannot authorize another materialization. */
function completeUnknownProjectOpenResult(details?: unknown): ActionExecuteResult {
  const operationId = readRecord(details).operationId;
  const unknown = OpenProjectResultV1Schema.safeParse({ kind: 'outcomeUnknown',
    ...(operationId === undefined ? {} : { operationId }) });
  return { ok: true, result: unknown.success ? unknown.data : { kind: 'outcomeUnknown' } };
}

/**
 * The one terminal Action boundary: public failures lose bridge-private
 * metadata and successful built-in Actions project through their declared
 * output schema. Approval admission is deliberately not an action output.
 */
export function settleActionOutput(actionId: ActionId, result: ActionExecuteResult, requestId?: string,
  publicOutputSchema?: Readonly<{ safeParse(value: unknown):
    Readonly<{ success: true; data: unknown }> | Readonly<{ success: false; error?: core.$ZodError }> }>,
  recordDiagnostic?: (diagnostic: ActionOutputDiagnostic) => void,
): ActionExecuteResult {
  const withCredentialUses = (settled: ActionExecuteResult): ActionExecuteResult => {
    const diagnostic = readActionOutputDiagnostic(settled) ?? readActionOutputDiagnostic(result);
    if (diagnostic) {
      try { recordDiagnostic?.({ ...diagnostic,
        source: diagnostic.source === 'action.output' ? `action.output:${actionId}` : diagnostic.source,
        ...(requestId ? { requestId } : {}) }); } catch { /* Diagnostics cannot replace settlement. */ }
    }
    if (!settled.ok && actionId === 'projects.open' && (settled.errorCode === 'outcome_unknown'
      || settled.errorCode === 'invalid_action_output' || settled.errorCode === 'result_too_large')) {
      settled = completeUnknownProjectOpenResult(settled.details);
    }
    const carriedCause = settled.ok ? undefined : readCarriedActionFailureCause(settled) ?? diagnostic?.failureCause;
    const projected = settled.ok ? settled : projectActionExecuteFailure({ ...settled,
      ...(carriedCause ? { failureCause: carriedCause } : {}) }, requestId);
    return result.operationCredentialUses?.length ? { ...projected, operationCredentialUses: result.operationCredentialUses } : projected;
  };
  if (!result.ok) return withCredentialUses(result);
  if (isDeferredApprovalResult(result)) return result;
  const spec = getActionSpec(actionId);
  if (spec.operation) {
    const accepted = ActionOperationAcceptedResultSchema.safeParse(result.result);
    if (accepted.success) return withCredentialUses({ ok: true, result: accepted.data });
  }
  const outputSchema = publicOutputSchema ?? spec.outputSchema;
  if (!outputSchema) return result;
  const invalidOutput = (error?: core.$ZodError, thrown?: unknown): ActionExecuteResult =>
    invalidActionOutputFailure(error, `action.output:${actionId}`, thrown);
  try {
    const output = outputSchema.safeParse(result.result);
    return withCredentialUses(output.success ? { ok: true, result: output.data } : invalidOutput(output.error));
  } catch (error) {
    return withCredentialUses(invalidOutput(undefined, error));
  }
}

/** Read the existing typed carrier, including old daemons' actionException details. */
function readCarriedActionFailureCause(error: unknown): ActionFailureCauseV1 | undefined {
  try {
    const record: Readonly<Record<string, unknown>> = isPluginError(error) ? error.data : readRecord(error);
    if (record.failureCause !== undefined) return readActionFailureCauseV1(record.failureCause);
    // Observed on the loaded 0.2 daemon: details carries the same closed cause
    // with an actionException discriminator. No exception text enters this projection.
    const { kind, ...legacyCause } = readRecord(record.details);
    if (kind === 'actionException') {
      return readActionFailureCauseV1(legacyCause);
    }
  } catch { /* A diagnostic carrier accessor cannot replace the original Action failure. */ }
  return undefined;
}

export function normalizeActionExecutorThrownError(error: unknown, phase?: string): Readonly<{ errorCode: string; error: string; requestId?: string; details?: unknown; failureCause: ActionFailureCauseV1; effectAttempted?: boolean }> {
  // An adapter may retain a child's public failure as its standard Error cause.
  // Raw exception causes never acquire the public Action contract implicitly.
  let carried = parseActionExecuteFailure(error);
  const codeWrapper = carried && Object.keys(carried).every(key => key === 'ok' || key === 'errorCode' || key === 'error');
  if (error instanceof Error && (!carried || codeWrapper)) {
    try {
      const child = parseActionExecuteFailure(error.cause);
      if (child && (!carried || carried.errorCode === child.errorCode)) carried = child;
    }
    catch { /* A private cause accessor cannot replace the original failure. */ }
  }
  const failure = carried ?? classifyActionExecutorThrownError(error);
  // Native Action adapters spread these fields into a failure; terminal projection removes the sidecar.
  return carryActionFailureDiagnostic({ ...failure, error: redactBugReportSensitiveText(failure.error),
    failureCause: readCarriedActionFailureCause(error) ?? carried?.failureCause ?? projectActionFailureCauseV1(error, phase) }, error, { enumerable: true });
}

function classifyActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown; effectAttempted?: boolean }> {
  if (error instanceof ActionCatalogUnavailableError) return { errorCode: error.code, error: error.code };
  if (error instanceof ApprovalRequestInvalid || error instanceof ApprovalRequestConflict)
    return { errorCode: error.code, error: error.code, ...(error.details ? { details: error.details } : {}) };
  const registrySourceUrlErrorCode = readRegistrySourceUrlErrorCodeV1(error);
  if (registrySourceUrlErrorCode) return { errorCode: registrySourceUrlErrorCode, error: registrySourceUrlErrorCode };
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
  const pluginFailure = readPluginActionError(error);
  if (pluginFailure) {
    const { diagnostics: _diagnostics, ...authorPayload } = readPluginActionFailureAuthorPayload(pluginFailure.data);
    return { errorCode: pluginFailure.code, error: pluginFailure.message,
      details: { name: 'PluginError', code: pluginFailure.code, message: pluginFailure.message,
        retryable: pluginFailure.retryable, ...authorPayload } };
  }
  const errorRecord = readRecord(error);
  if (errorRecord.code === 'action_account_scope_changed') {
    return { errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
  }
  const authorityFailure = readHomeAuthorityMismatchFailure(errorRecord.code, errorRecord.message);
  if (authorityFailure) return { errorCode: authorityFailure.code, error: authorityFailure.message,
    ...(authorityFailure.details ? { details: authorityFailure.details } : {}) };
  const sshFailure = readSshCommandFailure(errorRecord.code, errorRecord.message);
  if (sshFailure) return { errorCode: sshFailure.code, error: sshFailure.message };
  const enrollmentFailure = readRemoteEnrollmentCommandFailure(errorRecord.code, errorRecord.message);
  if (enrollmentFailure) return { errorCode: enrollmentFailure.code, error: enrollmentFailure.message,
    ...(enrollmentFailure.details ? { details: enrollmentFailure.details } : {}) };
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
  if (rawCodes[0] && (readRecord(rawDetails).kind === 'managedBootstrap' || readRecord(rawDetails).kind === 'managedService' || readRecord(rawDetails).kind === 'managedAgentIsolation'
    || ManagedGuestHomeFailureDetailsV1Schema.shape.kind.safeParse(readRecord(rawDetails).kind).success
    || ManagedAgentStartFailureDetailsV1Schema.shape.kind.safeParse(readRecord(rawDetails).kind).success)) {
    const failure = ActionOperationFailureV1Schema.safeParse({ errorCode: rawCodes[0], error: rawCodes[0], details: rawDetails });
    if (failure.success) {
      const details = failure.data.details;
      if (details && 'kind' in details && details.kind === 'managedService' && 'stderrTail' in details) {
        return { ...failure.data, details: { ...details, stderrTail: redactBugReportSensitiveText(details.stderrTail) } };
      }
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
      ? 'server_unreachable'
      // Ordinary exceptions can carry vendor codes; only the closed native
      // classifier or a typed failure above can give them public authority.
      : error instanceof Error && !isRpcError(error) ? readUnexpectedActionErrorDiagnosticV1(error).errorCode : protocolCode;
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
      ...(details === undefined ? {} : { details }),
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
  readMachineActionRpcResult(result);
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
