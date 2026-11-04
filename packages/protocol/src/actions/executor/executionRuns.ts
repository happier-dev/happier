import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { ExecutionRunLaunchOriginSchema, type ExecutionRunLaunchOrigin } from '../../execution/runs/startRequest.js';
import { DiscussionSelectionSourceV1Schema } from '../../discussions/content.js';
import { SessionInputSourceSessionV1Schema } from '../../sessions/messages/sessionInputAdmission.js';
import { normalizeId } from './inputReading.js';
import { normalizeResolvedOptions, tryNormalizeExecutionBackendOptionValue } from '../../inputs/inputOptions.js';
import { parseBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { BackendTargetKeyV2InputSchema } from '../../backends/targets/backendTargetRefV2.js';
import { TeamCredentialProviderModelSelectionV1Schema, type TeamCredentialProviderModelSelectionV1 } from '../../teams/credentials/resourceV1.js';
import { normalizeConnectedServiceSelectionInput } from '../../connect/normalizeConnectedServiceSelectionInput.js';
import { readRecord, isRecord, hasOwn } from '../../inputs/inputRecords.js';
import type { ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';
import { resolveExecutionBackendTargetSelectionForValue } from '../resolveActionBackendTargetSelection.js';
import { buildBackendTargetKey } from '../../backends/targets/backendTargetRef.js';
import { readExecutionRunStartRunCreation, ExecutionRunStartResponseSchema, ExecutionRunWaitResultSchema, withExecutionRunStartFailureDetails } from '../../execution/runs/responseSchemas.js';
import { readFailureEnvelopeDetails } from './actionFailureEnvelope.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import type { ActionExecuteFailure } from './types.js';
import { readUnexpectedActionErrorDiagnosticV1 } from '../actionExecutionResult.js';
import { type ActionId } from '../actionIds.js';

export function resolveExecutionRunLaunchOrigin(ctx: ActionExecutorContext): ExecutionRunLaunchOrigin {
  const mountedOrigin = ExecutionRunLaunchOriginSchema.safeParse(ctx.executionRunLaunchOrigin);
  if (mountedOrigin.success) return mountedOrigin.data;
  const discussionSource = DiscussionSelectionSourceV1Schema.safeParse(ctx.sessionInputSource);
  if (discussionSource.success) return discussionSource.data;
  const source = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
  if (source.success) {
    return { kind: 'session', sessionId: source.data.sourceSessionId };
  }
  if (ctx.surface === 'agent') {
    const sessionId = normalizeId(ctx.defaultSessionId);
    return sessionId ? { kind: 'session', sessionId } : { kind: 'external' };
  }
  if (ctx.surface === 'cli' || ctx.surface === 'mcp') {
    return { kind: 'external', source: ctx.surface };
  }
  return ctx.surface ? { kind: 'external', source: 'action' } : { kind: 'external' };
}

export type ExecutionRunCallOptions = NonNullable<
  Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2]
>;

export function buildExecutionRunCallOptions(
  authority: ActionExecutorContext['authority'],
  serverId: string | null,
  signal?: AbortSignal,
  originSessionId?: string | null,
  targetMachineId?: string | null,
  permissionRequestStore?: unknown,
  workflowObservationSink?: unknown,
  actionContext?: Pick<ActionExecutorContext, 'actionCaller' | 'actionRequestId' | 'requesterWorkAttributionV1' | 'onTransportIssued'
    | 'surface' | 'runtimeAccountId' | 'callerInputConstraints' | 'callerPermissionMode' | 'workspaceWrites'
    | 'externalActionCredential' | 'externalActionExecutionAuthorization' | 'externalActionTarget'>,
): ExecutionRunCallOptions | undefined {
  const origin = normalizeId(originSessionId);
  const target = normalizeId(targetMachineId);
  const actionRequestId = normalizeId(actionContext?.actionRequestId);
  const actionCaller = actionContext?.actionCaller;
  const requesterWorkAttributionV1 = actionContext?.requesterWorkAttributionV1;
  if (!serverId && !signal && !origin && !target
    && permissionRequestStore === undefined && workflowObservationSink === undefined
    && !actionRequestId && !actionCaller && !authority && !requesterWorkAttributionV1 && !actionContext?.onTransportIssued) return undefined;
  return {
    ...(serverId ? { serverId } : {}),
    ...(origin ? { originSessionId: origin } : {}),
    ...(target ? { targetMachineId: target } : {}),
    ...(signal ? { signal } : {}),
    ...(actionContext?.onTransportIssued ? { onTransportIssued: actionContext.onTransportIssued } : {}),
    ...(permissionRequestStore === undefined ? {} : { permissionRequestStore }),
    ...(workflowObservationSink === undefined ? {} : { workflowObservationSink }),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(actionCaller ? { actionCaller } : {}),
    ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
    ...(authority ? { authority } : {}),
    ...(actionContext?.surface ? { surface: actionContext.surface } : {}),
    ...(actionContext?.runtimeAccountId ? { runtimeAccountId: actionContext.runtimeAccountId } : {}),
    ...(actionContext?.callerInputConstraints ? { callerInputConstraints: actionContext.callerInputConstraints } : {}),
    ...(typeof actionContext?.callerPermissionMode === 'string' ? { effectiveCallerPermissionMode: actionContext.callerPermissionMode } : {}),
    ...(actionContext?.workspaceWrites ? { workspaceWrites: actionContext.workspaceWrites } : {}),
    ...(actionContext?.externalActionCredential ? { externalActionCredential: actionContext.externalActionCredential } : {}),
    ...(actionContext?.externalActionExecutionAuthorization ? { externalActionExecutionAuthorization: actionContext.externalActionExecutionAuthorization } : {}),
    ...(actionContext?.externalActionTarget ? { externalActionTarget: actionContext.externalActionTarget } : {}),
    ...(actionCaller?.kind === 'workflowRun' ? { workflowRunId: actionCaller.runId } : {}),
  };
}

export async function checkDetachedExecutionRunProtocolV2(
  deps: ActionExecutorDeps,
  sessionId: string | null,
  opts: ExecutionRunCallOptions | undefined,
  requirement: Readonly<{
    startAndWait: boolean;
    exactInputResults?: boolean;
    runScopedAgentBindings?: boolean;
    secretReferenceOverlay?: boolean;
  }>,
): Promise<
  | Readonly<{ ok: true; opts: ExecutionRunCallOptions | undefined }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>
> {
  // V2 is needed for any start-and-wait request, plus every detached control.
  // Ordinary Session-scoped immediate operations retain the V1 path.
  if (
    sessionId !== null
    && !requirement.startAndWait
    && requirement.exactInputResults !== true
    && requirement.runScopedAgentBindings !== true
    && requirement.secretReferenceOverlay !== true
  ) return { ok: true, opts };
  if (!deps.executionRunCheckProtocolV2) {
    return {
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      ...(requirement.secretReferenceOverlay === true ? {
        details: {
          updateRequired: {
            kind: 'update_required',
            operation: 'execution.run.start',
            component: 'daemon',
            reason: 'execution_run_secret_reference_overlay_update_required',
          },
        },
      } : {}),
    };
  }
  const capability = await deps.executionRunCheckProtocolV2(sessionId, {
    detachedScope: sessionId === null,
    startAndWait: requirement.startAndWait,
    exactInputResults: requirement.exactInputResults === true,
    runScopedAgentBindings: requirement.runScopedAgentBindings === true,
    secretReferenceOverlay: requirement.secretReferenceOverlay === true,
  }, opts);
  if (!capability.ok) {
    return requirement.secretReferenceOverlay === true
      && capability.errorCode === 'execution_run_protocol_unsupported'
      ? {
          ...capability,
          details: {
            updateRequired: {
              kind: 'update_required',
              operation: 'execution.run.start',
              component: 'daemon',
              reason: 'execution_run_secret_reference_overlay_update_required',
            },
          },
        }
      : capability;
  }
  return {
    ok: true,
    opts: capability.exactMachineId
      ? { ...(opts ?? {}), exactMachineId: capability.exactMachineId }
      : opts,
  };
}

export function normalizeExecutionBackendOptionValue(value: string): string {
  const normalized = tryNormalizeExecutionBackendOptionValue(value);
  if (!normalized) {
    throw new Error('invalid_backend_target_option');
  }
  return normalized;
}

export function normalizeExecutionBackendTargetValue(value: string) {
  return parseBackendTargetKeyV2(BackendTargetKeyV2InputSchema.parse(normalizeExecutionBackendOptionValue(value)));
}

function doesTeamCredentialSelectionTargetBackend(
  selection: TeamCredentialProviderModelSelectionV1,
  backendTargetValue: string,
): boolean {
  const target = BackendTargetKeyV2InputSchema.safeParse(tryNormalizeExecutionBackendOptionValue(backendTargetValue));
  const selectedTarget = BackendTargetKeyV2InputSchema.safeParse(selection.agentTargetKey);
  return target.success && selectedTarget.success && target.data === selectedTarget.data;
}

export function resolveFanoutTeamCredentialModel(
  data: Readonly<Record<string, unknown>>,
  backendTargetValues: readonly string[],
): { ok: true; selection: TeamCredentialProviderModelSelectionV1 | null } | { ok: false } {
  if (data.teamCredentialModel === undefined) return { ok: true, selection: null };
  const parsed = TeamCredentialProviderModelSelectionV1Schema.safeParse(data.teamCredentialModel);
  if (
    !parsed.success
    || backendTargetValues.length !== 1
    || data.modelSelection !== undefined
    || (typeof data.modelId === 'string' && data.modelId.trim() !== parsed.data.modelId)
    || !doesTeamCredentialSelectionTargetBackend(parsed.data, backendTargetValues[0]!)
  ) {
    return { ok: false };
  }
  return { ok: true, selection: parsed.data };
}

export function resolveFanoutConnectedServicesSelections(
  data: Readonly<Record<string, unknown>>,
  targetKeys: readonly string[],
) {
  const blanket = normalizeConnectedServiceSelectionInput(data.connectedServices);
  if (!blanket.ok) return { ok: false as const };
  const byTarget = data.connectedServicesByBackendTargetKey;
  if (byTarget !== undefined && !isRecord(byTarget)) return { ok: false as const };
  const selections = new Map<string, Readonly<{
    bindings: ConnectedServiceBindingsV2 | null | undefined;
    defaultServiceIds: readonly string[];
  }>>();
  // Normalize every selected target before starting any Run. Named service defaults
  // remain intent for the existing runtime default owner to merge under explicit pins.
  for (const key of targetKeys) {
    const raw = byTarget?.[key];
    const selection = raw === undefined ? blanket : normalizeConnectedServiceSelectionInput(raw);
    if (!selection.ok) return { ok: false as const };
    selections.set(key, selection);
  }
  return { ok: true as const, selections };
}

export function buildAvailableExecutionBackendOptionKeys(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const option of normalizeResolvedOptions(value)) {
    if (option.disabled === true) continue;
    const canonicalKey = tryNormalizeExecutionBackendOptionValue(option.value);
    if (!canonicalKey) continue;
    const raw = normalizeId(option.value);
    if (raw) keys.add(raw);
    keys.add(canonicalKey);
    const selection = resolveExecutionBackendTargetSelectionForValue(option.value);
    if (selection?.backendTarget) {
      keys.add(buildBackendTargetKey(selection.backendTarget));
    }
  }
  return keys;
}

export function readReviewRunActionPayload(value: unknown): unknown {
  const transport = readRecord(value);
  const native = transport.ok === true && transport.data !== undefined ? transport.data : value;
  const host = readRecord(native);
  return host.ok === true && host.result !== undefined ? host.result : native;
}

type FanoutResultItem = Readonly<{
  key: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  error?: string;
  details?: ReturnType<typeof withExecutionRunStartFailureDetails>;
}>;

function normalizeSuccessfulFanoutStartResult(result: unknown): unknown {
  const record = readRecord(result);
  if (
    record.ok === true
    && isRecord(record.data)
  ) {
    return record.data;
  }
  return result;
}

export function readFanoutStartError(result: unknown): Readonly<{
  errorCode?: string;
  error: string;
  details: ReturnType<typeof withExecutionRunStartFailureDetails>;
}> {
  const record = readRecord(result);
  const errorCode =
    typeof record.errorCode === 'string'
      ? String(record.errorCode)
      : typeof record.code === 'string'
          ? String(record.code)
          : undefined;
  const error =
    typeof record.error === 'string'
      ? String(record.error)
      : typeof record.message === 'string'
          ? String(record.message)
          : 'execution_run_failed';
  const details = readFailureEnvelopeDetails(record);
  return {
    error,
    ...(errorCode ? { errorCode } : {}),
    details: withExecutionRunStartFailureDetails(
      details,
      hasExecutionRunStartIdentityEvidence(result)
        ? 'outcomeUnknown'
        : readExecutionRunStartRunCreation(details),
    ),
  };
}

export async function fanoutStarts(params: Readonly<{
  keys: readonly string[];
  startOne: (key: string) => Promise<unknown>;
}>): Promise<readonly FanoutResultItem[]> {
  const results = await Promise.all(
    params.keys.map(async (key): Promise<FanoutResultItem> => {
      try {
        const rawResult = await params.startOne(key);
        const normalizedResult = normalizeSuccessfulFanoutStartResult(rawResult);
        const claimsFailure = readRecord(rawResult).ok === false || readRecord(normalizedResult).ok === false;
        const result = claimsFailure
          ? readCompleteExecutionRunStartIdentity(rawResult) ?? normalizedResult
          : normalizedResult;
        const resultRecord = readRecord(result);
        if (resultRecord.ok === false) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
          };
        }
        if (
          isRecord(result)
          && (
            typeof result.runId !== 'string'
            || typeof result.callId !== 'string'
            || typeof result.sidechainId !== 'string'
          )
        ) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
            details: withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown'),
          };
        }
        return { key, ok: true, result };
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error);
        const details = readFailureEnvelopeDetails(readRecord(error));
        return {
          key,
          ok: false,
          errorCode: failure.errorCode,
          error: failure.error,
          details: withExecutionRunStartFailureDetails(
            details,
            hasExecutionRunStartIdentityEvidence(error)
              ? 'outcomeUnknown'
              : readExecutionRunStartRunCreation(details),
          ),
        };
      }
    }),
  );
  return results;
}

export function readCompleteExecutionRunStartIdentity(result: unknown) {
  const record = readRecord(result);
  const wrapperClaimsFailure = record.ok === false;
  const candidates = hasOwn(record, 'data')
    ? [record.data, result]
    : [result];
  for (const candidate of candidates) {
    const candidateRecord = readRecord(candidate);
    const identity = ExecutionRunStartResponseSchema.safeParse({
      runId: candidateRecord.runId,
      callId: candidateRecord.callId,
      sidechainId: candidateRecord.sidechainId,
    });
    if (!identity.success) continue;
    if (wrapperClaimsFailure || candidateRecord.ok === false) return identity.data;
    const response = ExecutionRunStartResponseSchema.safeParse(candidate);
    return response.success ? response.data : identity.data;
  }
  return null;
}

export function hasExecutionRunStartIdentityEvidence(result: unknown): boolean {
  const record = readRecord(result);
  const candidates = hasOwn(record, 'data')
    ? [record.data, result]
    : [result];
  return candidates.some((candidate) => {
    const candidateRecord = readRecord(candidate);
    return hasOwn(candidateRecord, 'runId')
      || hasOwn(candidateRecord, 'callId')
      || hasOwn(candidateRecord, 'sidechainId');
  });
}

export function classifyExecutionRunStartFailure(
  result: ActionExecuteFailure,
  runCreation: 'noRunCreated' | 'outcomeUnknown',
  error?: unknown,
): ActionExecuteFailure {
  return {
    ...result,
    details: withExecutionRunStartFailureDetails(result.details, runCreation,
      error === undefined ? undefined : readUnexpectedActionErrorDiagnosticV1(error).errorClass),
  };
}

export function classifyExecutionRunStartPreDispatchFailure(
  actionId: ActionId,
  result: ActionExecuteFailure,
): ActionExecuteFailure {
  return actionId === 'execution.run.start'
    ? classifyExecutionRunStartFailure(result, 'noRunCreated')
    : result;
}

export function parseExecutionRunWaitResult(result: unknown): ReturnType<typeof ExecutionRunWaitResultSchema.safeParse> {
  const record = readRecord(result);
  // Transport failures may carry service-private diagnostics. Keep the public
  // wait disposition closed while successful observations retain the exact
  // canonical `execution.run.get` projection returned by the shared waiter.
  if (record.ok === false && typeof record.code === 'string') {
    return ExecutionRunWaitResultSchema.safeParse({ ok: false, code: record.code });
  }
  return ExecutionRunWaitResultSchema.safeParse(result);
}

export function isExecutionRunWaitCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError')
    || readRecord(error).name === 'AbortError';
}
