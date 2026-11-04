import type { ExecutionRunActionTransportOptions } from './types';
import type { CliActionDepsParams, CurrentMachineControlIdentity, ExecutionRunProtocolV2Requirement, ResolvedSessionTransport } from './types';
import { executionRunAuthorityCeiling } from './machineTransport';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { randomUUID } from 'node:crypto';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { withExecutionRunStartFailureDetails, ExecutionRunGetResponseSchema, ExecutionRunGetRequestSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readCliActionBoundSessionId } from '../resolveCliActionCallerSession';
import type { SessionResumeRequestV1 } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import type { cancelExecutionRunStream, ensureExecutionRun, ensureOrStartExecutionRun, executeExecutionRunAction, getExecutionRun, listExecutionRuns, readExecutionRunStream, startExecutionRun, startExecutionRunStream, stopExecutionRun, waitForExecutionRun } from '@/session/services/executionRuns';
import type { normalizeExecutionRunWaitTimeoutMs } from '@/session/services/executionRunWaitTiming';
import type { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import type { callExactMachineRpc, callMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { describeExecutionRunProtocolV2 } from './preflight';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';

import type { InactiveSessionResumeResult } from '@/session/services/requestInactiveSessionResume';


const DETACHED_EXECUTION_RUN_CALLER_LIFECYCLE_METHODS = new Set<string>([
  SESSION_RPC_METHODS.EXECUTION_RUN_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
  SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
  SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
  SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
]);
export type CliExecutionRunActionDeps = Pick<ActionExecutorDeps, "executionRunCheckProtocolV2" | "executionRunStart" | "executionRunList" | "executionRunGet" | "detachedExecutionRunSend" | "executionRunEnsure" | "executionRunEnsureOrStart" | "executionRunStreamStart" | "executionRunStreamRead" | "executionRunStreamCancel" | "executionRunCancelTurn" | "executionRunStop" | "executionRunAction" | "executionRunPermissionRespond" | "executionRunWait"> & Required<Pick<ActionExecutorDeps, 'executionRunStart' | 'executionRunList' | 'executionRunGet' | 'detachedExecutionRunSend' | 'executionRunWait'>>;
export type CliExecutionRunHost = Readonly<{
  resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
  readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
  resumeInactiveSessionTransport: (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    effectActionId: 'execution.run.start' | 'session.open' | 'session.user_action.answer';
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequest?: SessionResumeRequestV1;
  }>) => Promise<InactiveSessionResumeResult>;
  callMachineAction: CliMachineActionCall;
  isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
  normalizeStringValue: (value: unknown) => string | null;
  isExecutionRunActionAbort: (error: unknown, signal?: AbortSignal) => boolean;
  executionRunActionFailure: (code: string, message?: string, details?: unknown) => Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
}>;
export type CliExecutionRunFamily = Readonly<{
  actionDeps: CliExecutionRunActionDeps;
  callDetachedExecutionRunRpc: (sessionId: string | null, method: string, request: unknown, opts?: ExecutionRunActionTransportOptions) => Promise<unknown>;
  readExecutionRunTransportMachineId: (transport: ResolvedSessionTransport) => string | null;
}>;
export function createCliExecutionRunActionDeps(params: CliActionDepsParams, host: CliExecutionRunHost): CliExecutionRunFamily {
  const { resolveTransportForSession, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resumeInactiveSessionTransport, callMachineAction, isMachineActionServerScopeCurrent, normalizeStringValue, isExecutionRunActionAbort, executionRunActionFailure } = host;

  type ExecutionRunMachineTarget =
    | Readonly<{ ok: true; machineId: string }>
    | Readonly<{ ok: false; errorCode: 'execution_run_target_not_selected' | 'execution_run_target_unavailable' }>;

  const readExecutionRunTransportMachineId = (transport: ResolvedSessionTransport): string | null => {
    const metadata = readTransportSessionOwnerMetadata(transport);
    return normalizeStringValue(transport.rawSession.machineId)
      ?? normalizeStringValue(metadata?.machineId);
  };

  /**
   * Scope selection is authoritative before this point. This only resolves the
   * already-selected Session's daemon (or the caller's current device outside
   * a Session); it never scans, falls back, or accepts a machine id from Action
   * input.
   */
  const resolveExecutionRunMachineTarget = async (
    sessionId: string | null,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<ExecutionRunMachineTarget> => {
    const preflightMachineId = normalizeStringValue(opts?.exactMachineId);
    if (preflightMachineId) return { ok: true, machineId: preflightMachineId };

    // A bound host admits this target before Action dispatch. It is neither
    // mutable Action input nor a fallback candidate: V2 capability preflight
    // must interrogate this exact daemon before the resulting exactMachineId
    // pins every later control.
    const admittedMachineId = normalizeStringValue(opts?.targetMachineId);
    if (admittedMachineId) return { ok: true, machineId: admittedMachineId };

    const originSessionId = normalizeStringValue(opts?.originSessionId);
    const ownSessionId = readCliActionBoundSessionId(params.sessionId);
    const targetSessionId = sessionId ?? originSessionId ?? ownSessionId;

    if (targetSessionId) {
      const transport = await resolveTransportForSession(targetSessionId, opts?.signal);
      if (!transport.ok) return { ok: false, errorCode: 'execution_run_target_unavailable' };
      const machineId = readExecutionRunTransportMachineId(transport);
      return machineId
        ? { ok: true, machineId }
        : { ok: false, errorCode: 'execution_run_target_unavailable' };
    }

    const local = await readCurrentMachineControlIdentity();
    return local.machineId
      ? { ok: true, machineId: local.machineId }
      : { ok: false, errorCode: 'execution_run_target_not_selected' };
  };

  const requiresDirectExecutionRunTransport = (opts?: ExecutionRunActionTransportOptions) =>
    opts?.workDepth !== undefined || opts?.workspaceWrites !== undefined || opts?.permissionRequestStore !== undefined
      || opts?.workflowObservationSink !== undefined || opts?.workflowRunId !== undefined
      || opts?.requesterWorkAttributionV1 !== undefined || opts?.causalPermissionAuthority !== undefined
      || opts?.effectiveCallerPermissionMode !== undefined;

  const callDetachedExecutionRunRpc = async (
    sessionId: string | null,
    method: string,
    request: unknown,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<unknown> => {
    const isStart = method === SESSION_RPC_METHODS.EXECUTION_RUN_START;
    const failure = (code: string, runCreation: 'noRunCreated' | 'outcomeUnknown', message?: string) => ({
      ok: false as const,
      code,
      ...(message ? { message } : {}),
      ...(isStart
        ? { details: withExecutionRunStartFailureDetails(undefined, runCreation) }
        : {}),
    });
    if (!params.credentials) {
      return failure('not_authenticated', 'noRunCreated');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return failure(target.errorCode, 'noRunCreated');
    let result: unknown;
    try {
      const direct = params.machineActionDirectTargetTransport;
      if (requiresDirectExecutionRunTransport(opts) && direct?.machineId !== target.machineId) {
        return failure('execution_run_target_unavailable', 'noRunCreated');
      }
      if (direct?.machineId === target.machineId) {
        result = await direct.invoke(method, request, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(params.requesterSessionBootstrap
            ? { rpcContext: { requesterSessionBootstrap: params.requesterSessionBootstrap } }
            : {}),
          localActionContext: {
            ...(opts?.surface ? { surface: opts.surface } : {}),
            ...(opts?.authority ? { authority: opts.authority } : {}),
            ...(opts?.actionCaller ? { actionCaller: opts.actionCaller } : {}),
            ...(opts?.actionRequestId ? { actionRequestId: opts.actionRequestId } : {}),
            ...(opts?.workDepth === undefined ? {} : {
              surface: 'agent' as const,
              authority: 'account_automation' as const,
              agentStartWorkDepth: opts.workDepth,
              agentStartContext: opts.agentStartContext,
              sessionAgentSpawnPolicyV1: opts.sessionAgentSpawnPolicyV1,
              callerPermissionMode: opts.agentStartContext?.callerPermissionCeiling,
            }),
            // Retained sends have no start depth, but still carry their
            // admitted authority and current narrowed permission mode.
            ...(opts?.workDepth !== undefined || opts?.causalPermissionAuthority !== undefined
              ? { causalPermissionAuthority: opts.causalPermissionAuthority } : {}),
            ...(opts?.effectiveCallerPermissionMode !== undefined
              ? { callerPermissionMode: opts.effectiveCallerPermissionMode } : {}),
            ...(opts?.workspaceWrites === undefined ? {} : { agentStartWorkspaceWrites: opts.workspaceWrites }),
            ...(opts?.permissionRequestStore === undefined ? {} : { executionRunPermissionRequestStore: opts.permissionRequestStore }),
            ...(opts?.workflowObservationSink === undefined ? {} : { executionRunWorkflowObservationSink: opts.workflowObservationSink }),
            ...(opts?.workflowRunId ? { executionRunWorkflowRunId: opts.workflowRunId } : {}),
            ...(opts?.workflowScope ? { executionRunWorkflowScope: opts.workflowScope } : {}),
            ...(opts?.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: opts.requesterWorkAttributionV1 } : {}),
          },
          ...(opts?.permissionRequestStore === undefined
            ? {}
            : { executionRunPermissionRequestStore: opts.permissionRequestStore }),
          ...(opts?.workflowObservationSink === undefined
            ? {}
            : { executionRunWorkflowObservationSink: opts.workflowObservationSink }),
          ...(opts?.workflowRunId ? { executionRunWorkflowRunId: opts.workflowRunId } : {}),
          ...(opts?.workflowScope ? { executionRunWorkflowScope: opts.workflowScope } : {}),
        });
      } else {
        const getRequest = method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
          ? ExecutionRunGetRequestSchema.safeParse(request)
          : null;
        const { callMachineRpc } = await import("@/session/transport/rpc/machineRpc");
        result = await callMachineRpc({
          credentials: params.credentials,
          machineId: target.machineId,
          method,
          request,
          ...executionRunAuthorityCeiling(opts),
          ...(DETACHED_EXECUTION_RUN_CALLER_LIFECYCLE_METHODS.has(method)
            || getRequest?.success && Boolean(getRequest.data.waitForInputId || getRequest.data.waitForOutput)
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ
              && request !== null && typeof request === 'object' && 'waitForEvents' in request && request.waitForEvents === true
            ? { timeoutMs: null }
            : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
      }
    } catch (error) {
      const { readMachineRpcRequestDisposition } = await import("@/session/transport/rpc/machineRpc");
      const requestDisposition = readMachineRpcRequestDisposition(error);
      const runCreation = requestDisposition === 'notSent'
        ? 'noRunCreated'
        : 'outcomeUnknown';
      if (
        method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND
        && requestDisposition !== 'notSent'
      ) {
        return failure(
          'execution_run_send_outcome_unknown',
          'outcomeUnknown',
          'The execution-run input may have been accepted before its response failed',
        );
      }
      if (isExecutionRunActionAbort(error, opts?.signal)) {
        return failure('cancelled', runCreation);
      }
      return failure('execution_run_target_unavailable', runCreation);
    }
    // A received refusal is not a lost acknowledgement. Keep it outside the
    // transport uncertainty handler and ahead of any successful Run schema.
    return readMachineActionRpcResult(result);
  };

  const readExecutionRunProtocolV2 = async (
    sessionId: string | null,
    requirement: ExecutionRunProtocolV2Requirement,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<
    | Readonly<{ ok: true; exactMachineId: string }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > => {
    if (!params.credentials) {
      return executionRunActionFailure('not_authenticated');
    }
    if (opts?.signal?.aborted) {
      return executionRunActionFailure('cancelled');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return executionRunActionFailure(target.errorCode);
    return await describeExecutionRunProtocolV2(callMachineAction, target.machineId, requirement, opts);
  };
  const actionDeps: CliExecutionRunActionDeps = {
    executionRunCheckProtocolV2: async (sessionId, requirement, opts) => {
      if (
        !requirement.detachedScope
        && !requirement.startAndWait
        && !requirement.exactInputResults
        && !requirement.runScopedAgentBindings
        && !requirement.secretReferenceOverlay
      ) {
        return { ok: true };
      }
      return await readExecutionRunProtocolV2(sessionId, requirement, opts);
    },
    executionRunStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_START,
          request,
          opts,
        );
      }
      // Public Session RPC cannot authenticate a host-private admission stamp.
      // Refuse before resuming/sending instead of losing the admitted ceiling.
      if (opts?.workDepth !== undefined || opts?.workspaceWrites !== undefined) {
        return { ok: false, code: 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
      }
      let transport: Awaited<ReturnType<typeof resolveTransportForSession>>;
      try {
        transport = await resolveTransportForSession(sessionId, opts?.signal);
      } catch (error) {
        // Fresh transport preparation has not attempted resume or Start. Its
        // failure is positive evidence that this invocation created no Run.
        return { ok: false,
          code: isExecutionRunActionAbort(error, opts?.signal) ? 'cancelled' : 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
      }
      if (!transport.ok) {
        return {
          ok: false,
          code: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const admittedMachineId = normalizeStringValue(opts?.exactMachineId);
      if (
        admittedMachineId
        && readExecutionRunTransportMachineId(transport) !== admittedMachineId
      ) {
        return {
          ok: false,
          code: 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId: `execution.run.start:${randomUUID()}`,
        effectActionId: 'execution.run.start',
        ...(opts?.signal ? { signal: opts.signal } : {}),
        waitForReady: true,
      });
      if (!resumed.ok) {
        return {
          ok: false,
          code: 'execution_run_target_unavailable',
          message: resumed.message,
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const { startExecutionRun } = await import("@/session/services/executionRuns");
      return await startExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunList: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      const { listExecutionRuns } = await import("@/session/services/executionRuns");
      return await listExecutionRuns({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        skipLiveRpc: transport.rawSession.active === false,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunGet: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      const { getExecutionRun } = await import("@/session/services/executionRuns");
      return await getExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    detachedExecutionRunSend: async (sessionId, request, opts) =>
      await callDetachedExecutionRunRpc(
        sessionId,
        SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
        { ...request, sessionId },
        opts,
      ),
    executionRunEnsure: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      const { ensureExecutionRun } = await import("@/session/services/executionRuns");
      return await ensureExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunEnsureOrStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      const { ensureOrStartExecutionRun } = await import("@/session/services/executionRuns");
      return await ensureOrStartExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      const { startExecutionRunStream } = await import("@/session/services/executionRuns");
      return await startExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamRead: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      const { readExecutionRunStream } = await import("@/session/services/executionRuns");
      return await readExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamCancel: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      const { cancelExecutionRunStream } = await import("@/session/services/executionRuns");
      return await cancelExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunCancelTurn: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(sessionId, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request, opts);
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) return { ok: false, code: transport.code };
      const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
      return await callSessionRpc({
        ...transport, token: params.token, sessionId: transport.sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request,
        ...executionRunAuthorityCeiling(opts),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStop: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      const { stopExecutionRun } = await import("@/session/services/executionRuns");
      return await stopExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunAction: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      const { executeExecutionRunAction } = await import("@/session/services/executionRuns");
      return await executeExecutionRunAction({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunPermissionRespond: async (request, context) => {
      if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId: context.executionRunTargetMachineId, context, signal: context.signal })) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const target = await resolveExecutionRunMachineTarget(null, {
        targetMachineId: context.executionRunTargetMachineId,
        originSessionId: context.defaultSessionId,
        serverId: context.serverId,
        signal: context.signal,
      });
      if (!target.ok) return { ok: false, errorCode: target.errorCode, error: target.errorCode };
      const direct = params.machineActionDirectTargetTransport;
      if (direct?.machineId === target.machineId) {
        return readMachineActionRpcResult(await direct.invoke(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, request, {
          ...(context.signal ? { signal: context.signal } : {}),
          localActionContext: { ...context,
            executionRunTargetMachineId: context.executionRunTargetMachineId ?? undefined },
        }));
      }
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const { callExactMachineRpc } = await import("@/session/transport/rpc/machineRpc");
      return readMachineActionRpcResult(await callExactMachineRpc({
        credentials: params.credentials,
        machineId: target.machineId,
        serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
        request,
        ...executionRunAuthorityCeiling(context),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    },
    executionRunWait: async (sessionId, request, opts) => {
      if (sessionId === null) {
        if (!params.credentials) return { ok: false, code: 'not_authenticated' };
        const target = await resolveExecutionRunMachineTarget(sessionId, opts);
        if (!target.ok) return { ok: false, code: target.errorCode };
        const [{ waitForExecutionRun }, { normalizeExecutionRunWaitTimeoutMs }] = await Promise.all([import("@/session/services/executionRuns"), import("@/session/services/executionRunWaitTiming")]);
        return await waitForExecutionRun({ credentials: params.credentials, machineId: target.machineId,
          serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...executionRunAuthorityCeiling(opts), runId: request.runId,
          timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
          ...(request.condition ? { condition: request.condition } : {}),
          ...(request.after ? { after: ExecutionRunGetResponseSchema.parse(request.after) } : {}),
          ...(opts?.onSnapshot ? { onSnapshot: opts.onSnapshot } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(params.machineActionDirectTargetTransport?.machineId === target.machineId || requiresDirectExecutionRunTransport(opts)
            ? { invokeWait: (request: unknown, signal?: AbortSignal) =>
            callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, request,
              { ...opts, exactMachineId: target.machineId, ...(signal ? { signal } : {}) }) } : {}),
        });
      }
      const transport = await resolveTransportForSession(sessionId, opts?.signal);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }

      const [{ waitForExecutionRun }, { normalizeExecutionRunWaitTimeoutMs }] = await Promise.all([import("@/session/services/executionRuns"), import("@/session/services/executionRunWaitTiming")]);
      return await waitForExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        runId: request.runId,
        timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
        ...(request.condition ? { condition: request.condition } : {}),
        ...(request.after ? { after: ExecutionRunGetResponseSchema.parse(request.after) } : {}),
        ...(opts?.onSnapshot ? { onSnapshot: opts.onSnapshot } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
  };
  return { actionDeps, callDetachedExecutionRunRpc, readExecutionRunTransportMachineId };
}
