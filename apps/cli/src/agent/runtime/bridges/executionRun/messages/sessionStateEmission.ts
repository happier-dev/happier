import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import type { AgentMessageHandler, SessionId } from '@/agent/core/AgentMessage';
import type { ExecutionRunParentSessionPermissionRequestEnvelope } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { appendExecutionRunControllerHostBarrier } from '@/agent/executionRuns/controllers/failureSignal';
import type { ExecutionRunState } from '../executionRunTypes';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import { normalizePermissionRequestOptionsForAcp } from '@/agent/acp/bridge/acpCommonHandlers';
import {
  buildExecutionRunParentSessionPermissionRequestEnvelope,
  resolveExecutionRunPermissionInteractionMode,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { ExecutionRunPermissionRequestStoreProvider } from '../executionRunPermissionResponseTarget';
import type { ExecutionRunPermissionCapability } from '../executionRunHostRuntime';

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

function readRuntimeKindFromDescriptor(payload: unknown): string | null {
  const descriptor = readRecord(payload);
  if (!descriptor) return null;
  const direct = readNonEmptyString(descriptor.runtimeKind);
  if (direct) return direct;

  const provider = readRecord(descriptor.provider);
  if (!provider) return null;
  return readNonEmptyString(provider.backendMode);
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
  return readNonEmptyString(readRecord(payload)?.sessionId) ?? null;
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
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  runs: Map<string, ExecutionRunState>;
  backendSupportsResume: boolean;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
}>): AgentMessageHandler {
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: args.sendAcp,
    provider: args.parentProvider,
    sidechainId: args.sidechainId,
    makeId: () => randomUUID(),
  });
  let runtimeKind: string | null = null;
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
    if (args.ctrl.childSessionId) {
      void args.ctrl.backend.cancel(args.ctrl.childSessionId).catch(() => {});
    }
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

  return (msg) => {
    if (msg.type === 'event' && msg.name === 'runtime.descriptor') {
      // runtimeKind is a capability label for permission surfacing; the backend identity is already
      // present on the execution-run state and descriptor payload.
      runtimeKind = readRuntimeKindFromDescriptor(msg.payload);
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
        args.ctrl.childSessionId = providerSessionId;
        const run = args.runs.get(args.runId);
        if (run?.retentionPolicy === 'resumable' && args.backendSupportsResume) {
          args.runs.set(args.runId, {
            ...run,
            resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(run.backendTarget), providerSessionId },
          });
          args.onPublicStateUpdated?.(args.runId);
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
      const mode = resolveExecutionRunPermissionInteractionMode({
        intent: run.intent,
        runClass: run.runClass,
        ioMode: run.ioMode,
        retentionPolicy: run.retentionPolicy,
        permissionMode: run.permissionMode,
        parentSessionId: run.sessionId,
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

      if (mode !== 'prompt_in_parent_session' || !runtimeKind) {
        return;
      }

      const providerRequestId = readNonEmptyString(msg.id) ?? randomUUID();
      const envelope = buildExecutionRunParentSessionPermissionRequestEnvelope({
        sessionId: run.sessionId,
        runId: args.runId,
        callId: run.callId,
        sidechainId: args.sidechainId,
        backendId: run.backendId,
        runtimeKind,
        permissionMode: run.permissionMode,
        providerRequestId,
        providerMetadata,
        providerPayload,
        toolName,
        reason: readNonEmptyString(msg.reason) ?? toolName,
        createdAtMs: args.getNowMs(),
      });

      const requestStore = args.getPermissionRequestStore?.() ?? null;
      if (!requestStore) {
        denyPermissionRequestOrFail(providerRequestId);
        return;
      }

      requestStore.publishRequest({
        requestId: providerRequestId,
        toolName,
        toolInput: mergePermissionRequestOptionsForParentPrompt(
          normalizePermissionRequestOptionsForAcp(providerPayload),
          envelope,
        ),
        createdAt: envelope.createdAtMs,
        source: 'execution_run',
        responseTarget: envelope.responseTarget,
        sidechainId: args.sidechainId,
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

    forwarder.forward(msg);

    if (msg.type !== 'model-output') return;
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
}
