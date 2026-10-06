import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import type { AgentMessageHandler, SessionId } from '@/agent/core/AgentMessage';
import type { ExecutionRunParentSessionPermissionRequestEnvelope } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { appendExecutionRunControllerHostBarrier } from '@/agent/executionRuns/controllers/failureSignal';
import type { ExecutionRunTranscriptPublisher } from '../executionRunTranscriptPublisher';
import type { ExecutionRunState } from '../executionRunTypes';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { normalizePermissionRequestOptionsForAcp } from '@/agent/acp/bridge/acpCommonHandlers';
import {
  buildExecutionRunParentSessionPermissionRequestEnvelope,
  resolveExecutionRunPermissionInteractionMode,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { buildRunScopedExecutionPermissionRequestId } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import type { ExecutionRunPermissionRequestStoreProvider } from '../executionRunPermissionResponseTarget';
import type { ExecutionRunPermissionCapability } from '../executionRunHostRuntime';
import { createExecutionRunCodedError } from '../errors';
import { EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { createExecutionRunTranscriptCustodyError } from '../executionRunTranscriptPublisher';

/**
 * One writer signature, parameterized over its owner's option/result contract.
 *
 * The bridge's stable transcript publisher and the Session client's durable
 * committed writer disagree on options and result, but both are the same
 * `(provider, body, …)` seam. Rest parameters keep one projection owner instead
 * of a second sidechain stamper per consumer.
 */
type ExecutionRunSidechainEnqueue<TRest extends unknown[], TResult> = (
  provider: ACPProvider,
  body: ACPMessageData,
  ...rest: TRest
) => Promise<TResult>;

export function createExecutionRunTranscriptProjection<TRest extends unknown[], TResult>(args: Readonly<{
  controller: ExecutionRunBackendController;
  sidechainId: string;
  isCurrent: () => boolean;
  session: Readonly<{
    sessionId: string;
    enqueueAgentMessageCommitted?: ExecutionRunSidechainEnqueue<TRest, TResult>;
  }>;
}>): Readonly<{ enqueueAgentMessageCommitted?: ExecutionRunSidechainEnqueue<TRest, TResult> }> {
  const enqueue = args.session.enqueueAgentMessageCommitted;
  if (!enqueue) return Object.freeze({});
  return Object.freeze({
    async enqueueAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, ...rest: TRest) {
      if (!args.isCurrent() || args.controller.cancelled) throw createExecutionRunTranscriptCustodyError();
      const acceptance = args.controller.pendingInputAcceptance;
      if (acceptance && await acceptance !== 'accepted') throw createExecutionRunTranscriptCustodyError();
      return await enqueue(provider, { ...body, sidechainId: args.sidechainId }, ...rest);
    },
  });
}

const EXECUTION_RUN_TASK_OUTPUT_LIMIT_ERROR_CODE = 'execution_run_output_limit_exceeded';
const EXECUTION_RUN_TASK_OUTPUT_LIMIT_ERROR_MESSAGE = 'Execution-run task output exceeded the configured limit.';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readPermissionCapability(value: unknown): ExecutionRunPermissionCapability | null {
  return value === 'responds' || value === 'inline' || value === 'static' ? value : null;
}

function readRuntimePermissionCapability(payload: unknown): ExecutionRunPermissionCapability | null {
  const capabilities = readRecord(payload);
  if (!capabilities) return null;
  const permissions = readRecord(capabilities.permissions);
  const backend = readRecord(capabilities.backend);
  const backendPermissions = readRecord(backend?.permissions);
  return readPermissionCapability(permissions?.capability)
    ?? readPermissionCapability(capabilities.permissionCapability)
    ?? readPermissionCapability(backendPermissions?.capability);
}

function readProviderSessionId(payload: unknown): SessionId | null {
  return readNonBlankOpaqueIdentifier(readRecord(payload)?.sessionId);
}

function isExecutionRunActivityMessage(msg: Parameters<AgentMessageHandler>[0]): boolean {
  switch (msg.type) {
    case 'model-output':
    case 'tool-call':
    case 'tool-result':
    case 'status':
    case 'fs-edit':
    case 'terminal-output':
    case 'exec-approval-request':
    case 'patch-apply-begin':
    case 'patch-apply-end':
    case 'permission-request':
      return true;
    case 'event':
      return msg.name === 'thinking';
    default:
      return false;
  }
}

function mergePermissionRequestOptionsForParentPrompt(
  options: unknown,
  executionRun: ExecutionRunParentSessionPermissionRequestEnvelope,
): unknown {
  const optionRecord = readRecord(options);
  if (!optionRecord) {
    return { executionRun };
  }

  return {
    ...optionRecord,
    executionRun,
  };
}

const FAIL_CLOSED_PERMISSION_REQUEST_ERROR = 'Execution-run permission request cannot be surfaced or denied';

type FailClosedPermissionReason =
  | 'static'
  | 'inline_no_pending_request'
  | 'no_active_session'
  | 'unknown_request'
  | 'transport_error';

export function createExecutionRunControllerMessageHandler(args: Readonly<{
  ctrl: ExecutionRunBackendController;
  runId: string;
  sidechainId: string;
  ioMode: ExecutionRunState['ioMode'];
  computeSidechainStreamText: (fullText: string) => string | null;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  runs: Map<string, ExecutionRunState>;
  backendSupportsResume: boolean;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
}>): AgentMessageHandler {
  const publishTranscriptFact = (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }): void => {
    args.ctrl.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
      args.ctrl.pendingHostBarrier,
      () => args.sendAcp(provider, body, opts),
    );
  };
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: publishTranscriptFact,
    provider: args.parentProvider,
    sidechainId: args.sidechainId,
    makeId: () => randomUUID(),
  });
  let permissionCapability: ExecutionRunPermissionCapability = args.ctrl.backend.permissionCapability ?? 'static';

  function createFailClosedPermissionRequestError(
    reason: FailClosedPermissionReason,
    capability: ExecutionRunPermissionCapability = permissionCapability,
  ): Error {
    const error = new Error(FAIL_CLOSED_PERMISSION_REQUEST_ERROR);
    Object.defineProperty(error, 'executionRunPermissionDiagnostic', {
      enumerable: true,
      value: {
        runId: args.runId,
        reason,
        capability,
      },
    });
    return error;
  }

  function terminalizeFailClosedPermissionRequest(error: Error): void {
    args.ctrl.failureSignal?.fail(error);
    if (args.ctrl.runtimeId) {
      void args.ctrl.backend.cancel(args.ctrl.runtimeId).catch(() => {});
    }
  }

  function terminalizeExecutionResultOutputLimit(): void {
    const error = createExecutionRunCodedError(
      EXECUTION_RUN_TASK_OUTPUT_LIMIT_ERROR_CODE,
      EXECUTION_RUN_TASK_OUTPUT_LIMIT_ERROR_MESSAGE,
    );
    args.ctrl.failureSignal?.fail(error);
    if (args.ctrl.runtimeId) {
      void args.ctrl.backend.cancel(args.ctrl.runtimeId).catch(() => {});
    }
  }

  function exceedsExecutionResultOutputLimit(
    msg: Extract<Parameters<AgentMessageHandler>[0], { type: 'model-output' }>,
  ): boolean {
    const intent = args.runs.get(args.runId)?.intent;
    if (intent !== 'task' && intent !== 'agent') return false;
    if (typeof msg.fullText === 'string') {
      return msg.fullText.length > EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS;
    }
    if (typeof msg.textDelta !== 'string') return false;
    return args.ctrl.buffer.length + msg.textDelta.length > EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS;
  }

  function readEffectivePermissionCapability(): ExecutionRunPermissionCapability {
    return args.ctrl.backend.permissionCapability ?? permissionCapability;
  }

  function denyPermissionRequestOrFail(providerRequestId: string | null): void {
    const declaredCapability = readEffectivePermissionCapability();
    if (declaredCapability !== 'responds') {
      const error = createFailClosedPermissionRequestError(
        declaredCapability === 'inline' ? 'inline_no_pending_request' : 'static',
        declaredCapability,
      );
      terminalizeFailClosedPermissionRequest(error);
      throw error;
    }
    const respondToPermission = declaredCapability === 'responds'
      ? args.ctrl.backend.respondToPermission
      : undefined;
    if (!providerRequestId || !respondToPermission) {
      const error = createFailClosedPermissionRequestError('no_active_session', declaredCapability);
      terminalizeFailClosedPermissionRequest(error);
      throw error;
    }

    try {
      const denyTransport = respondToPermission(providerRequestId, false).then(
        (outcome) => {
          if (outcome.delivered === true) return;
          terminalizeFailClosedPermissionRequest(createFailClosedPermissionRequestError(
            outcome.reason,
            declaredCapability,
          ));
        },
        () => {
          terminalizeFailClosedPermissionRequest(createFailClosedPermissionRequestError(
            'transport_error',
            declaredCapability,
          ));
        },
      );
      args.ctrl.pendingHostBarrier = appendExecutionRunControllerHostBarrier(args.ctrl.pendingHostBarrier, denyTransport);
    } catch {
      const error = createFailClosedPermissionRequestError('transport_error', declaredCapability);
      terminalizeFailClosedPermissionRequest(error);
      throw error;
    }
  }

  const publishMessage: AgentMessageHandler = (msg) => {
    if (msg.type === 'event' && msg.name === 'runtime.descriptor') {
      // The provider-owned descriptor stays opaque to the generic run bridge.
      forwarder.forward(msg);
      return;
    }

    if (msg.type === 'event' && msg.name === 'runtime.capabilities') {
      permissionCapability = readRuntimePermissionCapability(msg.payload) ?? 'static';
      forwarder.forward(msg);
      return;
    }

    if (msg.type === 'event' && (msg.name === 'provider_session_id' || msg.name === 'vendor_session_id')) {
      const providerSessionId = readProviderSessionId(msg.payload);
      if (providerSessionId) {
        // Provider identity is a resume handle only. The provisioned child id
        // remains the host control address for delivery and cancellation.
        const run = args.runs.get(args.runId);
        if (run?.retentionPolicy === 'resumable'
          && args.backendSupportsResume
          && args.ctrl.providerResumeIdentityObserved !== true) {
          const providerResumeIdentity = {
            kind: 'provider_session.v1' as const,
            backendTarget: readBackendTargetRefV2(run.backendTarget),
            providerSessionId,
          };
          args.runs.set(args.runId, {
            ...run,
            resumeHandle: providerResumeIdentity,
          });
          args.ctrl.providerResumeIdentityObserved = true;
          args.onPublicStateUpdated?.(args.runId);
          const workflowObservation = args.ctrl.workflowObservation;
          if (workflowObservation) {
            args.ctrl.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
              args.ctrl.pendingHostBarrier,
              () => workflowObservation.sink.commit({
                kind: 'provider_resume_identity',
                runId: args.runId,
                localInputId: workflowObservation.localInputId,
                providerResumeIdentity,
              }),
            );
          }
        }
      }
      return;
    }

    const shouldWriteActivityMarker = isExecutionRunActivityMessage(msg);
    if (shouldWriteActivityMarker) {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    }

    if (msg.type === 'permission-request') {
      const run = args.runs.get(args.runId) ?? null;
      if (!run) return;

      const providerMetadata = readRecord(msg.payload);
      const providerPayload = msg.payload ?? {};
      const toolName = readNonEmptyString(providerMetadata?.toolName)
        ?? readNonEmptyString(msg.reason)
        ?? 'unknown';
      const parentSessionId = run.sessionId;
      // Parent-prompt routing needs a stable host identity, not a provider
      // backend mode. `backendId` is already the canonical run-owned target.
      const runtimeKind = readNonEmptyString(run.backendId);
      const requestStore = args.getPermissionRequestStore?.() ?? null;
      const mode = resolveExecutionRunPermissionInteractionMode({
        intent: run.intent,
        runClass: run.runClass,
        ioMode: run.ioMode,
        retentionPolicy: run.retentionPolicy,
        permissionMode: run.permissionMode,
        parentSessionId,
        interactionTargetAvailable: requestStore !== null,
        backendCapabilities: {
          canRespondToPermission: readEffectivePermissionCapability() === 'responds',
          canSurfaceParentSessionPrompt: runtimeKind !== null,
          ...(runtimeKind ? { runtimeKind } : {}),
          backendId: run.backendId,
        },
      });

      if (mode === 'deterministic' || mode === 'fail_closed') {
        denyPermissionRequestOrFail(readNonEmptyString(msg.id));
        return;
      }

      if (mode === 'interaction_unavailable') {
        const error = createExecutionRunCodedError(
          'execution_run_interaction_unavailable',
          'Execution-run permission interaction target is unavailable',
        );
        terminalizeFailClosedPermissionRequest(error);
        throw error;
      }

      if (mode !== 'prompt_in_execution_scope' || !runtimeKind) {
        return;
      }

      const providerRequestId = readNonEmptyString(msg.id) ?? randomUUID();
      const requestId = buildRunScopedExecutionPermissionRequestId({
        runId: args.runId,
        controllerOccurrenceId: args.ctrl.controllerOccurrenceId,
        providerRequestId,
      });
      const envelope = buildExecutionRunParentSessionPermissionRequestEnvelope({
        sessionId: parentSessionId,
        runId: args.runId,
        callId: run.callId,
        sidechainId: args.sidechainId,
        backendId: run.backendId,
        runtimeKind,
        permissionMode: run.permissionMode,
        providerRequestId,
        controllerOccurrenceId: args.ctrl.controllerOccurrenceId,
        providerMetadata,
        providerPayload,
        toolName,
        reason: readNonEmptyString(msg.reason) ?? toolName,
        createdAtMs: args.getNowMs(),
      });

      if (!requestStore) {
        denyPermissionRequestOrFail(providerRequestId);
        return;
      }

      const publication = {
        requestId,
        toolName,
        toolInput: mergePermissionRequestOptionsForParentPrompt(
          normalizePermissionRequestOptionsForAcp(providerPayload),
          envelope,
        ),
        createdAt: envelope.createdAtMs,
        source: 'execution_run',
        responseTarget: envelope.responseTarget,
        sidechainId: args.sidechainId,
      };
      // Native and message-based permission producers wake the same Run source
      // only after the request owner has accepted its fact.
      args.ctrl.pendingHostBarrier = appendExecutionRunControllerHostBarrier(args.ctrl.pendingHostBarrier, async () => {
        if (requestStore.publishRequestAndWait) await requestStore.publishRequestAndWait(publication);
        else requestStore.publishRequest(publication);
        args.onPublicStateUpdated?.(args.runId);
      });
      return;
    }

    if (
      args.ctrl.streamWriter
      && (
        msg.type === 'tool-call'
        || msg.type === 'tool-result'
        || msg.type === 'fs-edit'
        || msg.type === 'terminal-output'
      )
    ) {
      args.ctrl.streamWriter.flushAll({ reason: 'tool-call-boundary' });
    }

    if (msg.type !== 'model-output') {
      forwarder.forward(msg);
      return;
    }
    if (exceedsExecutionResultOutputLimit(msg)) {
      terminalizeExecutionResultOutputLimit();
      return;
    }
    forwarder.forward(msg);
    const prevFullText = args.ctrl.buffer;
    if (typeof msg.fullText === 'string') {
      args.ctrl.buffer = msg.fullText;
    } else if (typeof msg.textDelta === 'string') {
      args.ctrl.buffer += msg.textDelta;
    }

    // Streaming: emit best-effort sidechain transcript updates.
    const streamWriter = args.ctrl.streamWriter;
    if (args.ioMode === 'streaming' && streamWriter) {
      const streamKey = `${args.sidechainId}:turn:${args.ctrl.turnCount}`;
      if (!args.ctrl.sidechainStreamKey || args.ctrl.sidechainStreamKey !== streamKey) {
        args.ctrl.sidechainStreamKey = streamKey;
        args.ctrl.sidechainStreamBuffer = '';
      }

      const nextStreamText = args.computeSidechainStreamText(args.ctrl.buffer);
      if (typeof nextStreamText === 'string') {
        const prevStreamText = args.ctrl.sidechainStreamBuffer;

        const delta = (() => {
          if (nextStreamText.startsWith(prevStreamText)) {
            return nextStreamText.slice(prevStreamText.length);
          }

          // Fallback: if the backend reports cumulative fullText but it diverges (vendor bug/restarts),
          // emit the delta between previous and current fullText as best-effort.
          if (args.ctrl.buffer === prevFullText) return '';
          return nextStreamText;
        })();

        if (delta && delta.length > 0) {
          args.ctrl.sidechainStreamBuffer = nextStreamText;
          streamWriter.appendAssistantDelta(delta, { sidechainId: args.sidechainId });
        }
      }
    }

    args.onModelOutput?.();
  };
  return (message) => {
    const acceptance = args.ctrl.pendingInputAcceptance;
    if (!acceptance) {
      publishMessage(message);
      return;
    }
    args.ctrl.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
      args.ctrl.pendingHostBarrier,
      async () => {
        if (await acceptance === 'accepted') publishMessage(message);
      },
    );
  };
}
