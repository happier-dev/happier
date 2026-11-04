import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { readConnectedServiceUxDiagnosticFromError } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunStopResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema, ExecutionRunUserTranscriptCommitResponseSchema, type ExecutionRunTurnStreamReadResponse } from '@happier-dev/protocol/execution/runs/streaming';
import { ExecutionRunPreparedInstructionsForSchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import type { ExecutionRunUserTranscriptDirective, VoiceAssistantAction } from '@happier-dev/protocol';

import type { VoiceAgentClient, VoiceAgentStartParams, VoiceAgentStartResult, VoiceAgentSendTurnOptions } from './types';
import { streamVoiceAgentTurn } from './streamVoiceAgentTurn';
import { requiresProviderSafeModelSelectionRpc } from '@/sync/ops/providerDaemonSessionCompatibility';
import { requiresProviderSafeExecutionRunStartRpc } from '@happier-dev/protocol/execution/runs/startRequest';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { sleepWithSignal } from '@happier-dev/plugin-sdk/async';
import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { resolveVoiceTurnStreamReadConfig } from './resolveVoiceTurnStreamReadConfig';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

const VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS = null;

type SafeParseSuccess<T> = { success: true; data: T };
type SafeParseFailure = { success: false; error: unknown };
type SafeParseOutput<S> =
  S extends { safeParse: (v: unknown) => SafeParseSuccess<infer T> | SafeParseFailure } ? T : unknown;

function ensureOk<S extends { safeParse: (v: unknown) => unknown }>(value: unknown, schema: S): SafeParseOutput<S> {
  const parsed = schema.safeParse(value);
  if (parsed && typeof parsed === 'object' && (parsed as any).success === true) return (parsed as any).data;
  throw new Error('invalid_rpc_response');
}

function throwIfRpcError(value: unknown): void {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
    const uxDiagnostic = readConnectedServiceUxDiagnosticFromError(value);
    throw Object.assign(createRpcCallError({ error: value.error,
      errorCode: 'errorCode' in value && typeof value.errorCode === 'string' ? value.errorCode : undefined }), uxDiagnostic ? { uxDiagnostic } : {});
  }
}

function normalizeVoiceAgentModelId(value: unknown, preserveDefault = false): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (!preserveDefault && trimmed === 'default')) return null;
  return trimmed;
}

function normalizeVoiceAgentLaunchProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class VoiceAgentStartOutcomeUnknownError extends Error {
  readonly code = 'VOICE_AGENT_START_OUTCOME_UNKNOWN';
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Voice agent start acknowledgement was not received; outcome is unknown');
    this.name = 'VoiceAgentStartOutcomeUnknownError';
    this.cause = cause;
  }
}

export class DaemonVoiceAgentClient implements VoiceAgentClient {
  constructor(private readonly scope: ServerAccountScope, private readonly lifetimeSignal?: AbortSignal) {}

  private async sessionRpc<R, A>(params: Readonly<{
    sessionId: string;
    method: string;
    payload: A;
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>): Promise<R> {
    // Cleanup is a separate Account-owned request. It must still reach the
    // daemon after Stop retires the Voice attempt and its pending operations.
    if (params.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP
        || params.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
      return await sessionRpcWithServerAccountScope<R, A>({ ...params, scope: this.scope });
    }
    const lifetime = mergeAbortSignals([params.signal, this.lifetimeSignal]);
    try {
      return await sessionRpcWithServerAccountScope<R, A>({ ...params, scope: this.scope, signal: lifetime.signal });
    } finally {
      lifetime.dispose();
    }
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    const backendId = String(params.agentId ?? '').trim();
    if (!params.backendTarget && !backendId) {
      throw Object.assign(new Error('voice_agent_selection_unavailable'), {
        code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
      });
    }
    const backendTarget = params.backendTarget ?? readBackendTargetRefV2({ kind: 'builtInAgent', agentId: backendId });
    const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
    const chatModelId = normalizeVoiceAgentModelId(params.chatModelId);
    const commitModelId = normalizeVoiceAgentModelId(params.commitModelId, true);
    const launchProfileId = normalizeVoiceAgentLaunchProfileId(params.launchProfileId);
    const chatModelSelection = params.chatModelSelection ?? (chatModelId
      ? { agentTargetKey, providerConnectionId: null, modelId: chatModelId }
      : params.chatModelId?.trim() === 'default' ? null : undefined);
    const commitModelSelection = params.commitModelSelection ?? (commitModelId && commitModelId !== 'default'
      ? { agentTargetKey, providerConnectionId: null, modelId: commitModelId }
      : undefined);
    const ensureOrStartMethod = requiresProviderSafeExecutionRunStartRpc({ modelSelection: chatModelSelection }, true)
      || requiresProviderSafeModelSelectionRpc(chatModelSelection, commitModelSelection)
      ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1
      : SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START;
    const startPayload = {
      intent: 'voice_agent',
      backendTarget,
      permissionMode: params.permissionIntent,
      retentionPolicy: params.retentionPolicy ?? 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      ...(params.resumeHandle ? { resumeHandle: params.resumeHandle } : {}),
      ...(chatModelId ? { chatModelId } : {}),
      ...(commitModelId ? { commitModelId } : {}),
      ...(chatModelSelection !== undefined
        ? {
            ...(chatModelSelection ? { modelId: chatModelSelection.modelId } : {}),
            modelSelection: chatModelSelection,
          }
        : {}),
      ...(commitModelSelection || params.voicePolicy
        ? { intentInput: {
            ...(commitModelSelection ? { commitModelSelection } : {}),
            ...(params.voicePolicy ? { voicePolicy: params.voicePolicy } : {}),
          } }
        : {}),
      ...(params.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides }
        : {}),
      ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
      ...(params.commitIsolation === true ? { commitIsolation: true } : {}),
      ...(launchProfileId ? { launchProfileId } : {}),
      idleTtlSeconds: params.idleTtlSeconds,
      initialContext: params.initialContext,
      initialContextMode: params.initialContextMode,
      verbosity: params.verbosity,
      bootstrapMode: params.bootstrapMode,
      ...(typeof params.bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs: params.bootstrapTimeoutMs } : {}),
      ...(Array.isArray(params.disabledActionIds) && params.disabledActionIds.length > 0 ? { disabledActionIds: params.disabledActionIds } : {}),
      ...(params.transcript ? { transcript: params.transcript } : {}),
      ...(params.replay ? { replay: params.replay } : {}),
    };

    const ensureOrStart = async () => {
      const res: any = await this.sessionRpc({
        sessionId: params.sessionId,
        method: ensureOrStartMethod,
        timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
        payload: {
          runId: typeof params.existingRunId === 'string' ? params.existingRunId : null,
          resume: params.resumeWhenInactive !== false,
          start: startPayload,
        },
      });
      throwIfRpcError(res);
      const parsed = ensureOk(res, ExecutionRunEnsureOrStartResponseSchema);
      if (!parsed.ok) throw createRpcCallError({ error: parsed.error, errorCode: parsed.errorCode });
      return { voiceAgentId: parsed.runId,
        ...(parsed.preparedInstructionsFor ? { preparedInstructionsFor: parsed.preparedInstructionsFor } : {}) };
    };

    try {
      return await ensureOrStart();
    } catch (error) {
      if (isSocketIoAckTimeoutError(error)) {
        throw new VoiceAgentStartOutcomeUnknownError(error);
      }
      throw error;
    }
  }

  async sendTurn(
    params: Readonly<{
      sessionId: string;
      voiceAgentId: string;
      userText: string;
      displayUserText?: string;
      signal?: AbortSignal;
      userTranscript?: ExecutionRunUserTranscriptDirective;
      onUserTranscriptAccepted?: () => void | Promise<void>;
      onPreparedInstructionsFor?: VoiceAgentSendTurnOptions['onPreparedInstructionsFor'];
    }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    // The non-streaming daemon turn shares the single canonical turn read-loop. We omit
    // No output observer is needed in this non-streaming path, but reuse the same
    // event-wait / abort / cancel semantics from streamVoiceAgentTurn so there is exactly
    // one parser and one abort path for daemon turns.
    const handle = {
      client: this,
      voiceAgentId: params.voiceAgentId,
      backend: 'daemon',
      rpcSessionId: params.sessionId,
      agentBackendId: null,
    };
    return await streamVoiceAgentTurn({
      sessionId: params.sessionId,
      handle,
      userText: params.userText,
      displayUserText: typeof params.displayUserText === 'string' ? params.displayUserText : params.userText,
      ...((params.signal || params.userTranscript || params.onUserTranscriptAccepted || params.onPreparedInstructionsFor) ? {
        options: {
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.userTranscript ? { userTranscript: params.userTranscript } : {}),
          ...(params.onUserTranscriptAccepted
            ? { onUserTranscriptAccepted: params.onUserTranscriptAccepted }
            : {}),
          ...(params.onPreparedInstructionsFor ? { onPreparedInstructionsFor: params.onPreparedInstructionsFor } : {}),
        },
      } : {}),
    });
  }

  async welcome(params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>): ReturnType<VoiceAgentClient['welcome']> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
      payload: {
        runId: params.voiceAgentId,
        actionId: 'voice_agent.welcome',
        ...(typeof params.welcomeText === 'string'
          ? { input: { welcomeText: params.welcomeText } }
          : {}),
      },
    });
    throwIfRpcError(res);
    const parsed = ensureOk(res, ExecutionRunActionResponseSchema);
    const result = parsed.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_rpc_response');
    const assistantText: unknown = Reflect.get(result, 'assistantText');
    if (typeof assistantText !== 'string') {
      throw new Error('invalid_rpc_response');
    }
    const prepared: unknown = Reflect.get(result, 'preparedInstructionsFor');
    const preparedInstructionsFor = prepared === undefined ? undefined : ensureOk(prepared, ExecutionRunPreparedInstructionsForSchema);
    return { assistantText, ...(preparedInstructionsFor ? { preparedInstructionsFor } : {}) };
  }

  async startTurnStream(params: Readonly<{
    sessionId: string;
    voiceAgentId: string;
    userText: string;
    displayUserText?: string;
    speechSegmentTargetChars?: number;
    resume?: boolean;
    userTranscript?: ExecutionRunUserTranscriptDirective;
    signal?: AbortSignal;
  }>): Promise<{ streamId: string }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: params.userTranscript
        ? SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
        : SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
      signal: params.signal,
      payload: {
        runId: params.voiceAgentId,
        message: params.userText,
        ...(params.speechSegmentTargetChars !== undefined
          ? { speechSegmentTargetChars: params.speechSegmentTargetChars }
          : {}),
        ...(typeof params.displayUserText === 'string' && params.displayUserText.trim().length > 0
          ? { displayMessage: params.displayUserText }
          : {}),
        ...(params.resume === true ? { resume: true } : {}),
        ...(params.userTranscript ? { userTranscript: params.userTranscript } : {}),
      },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunTurnStreamStartResponseSchema);
  }

  async commitUserTranscript(params: Readonly<{
    sessionId: string;
    voiceAgentId: string;
    text: string;
    displayText?: string;
    localId: string;
  }>): Promise<{ ok: true }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
      payload: {
        runId: params.voiceAgentId,
        message: params.text,
        ...(typeof params.displayText === 'string' ? { displayMessage: params.displayText } : {}),
        localId: params.localId,
      },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunUserTranscriptCommitResponseSchema);
  }

  async readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number; waitForEvents?: boolean; signal?: AbortSignal }>,
  ): Promise<ExecutionRunTurnStreamReadResponse> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
      signal: params.signal,
      ...(params.waitForEvents ? { timeoutMs: null } : {}),
      payload: {
        runId: params.voiceAgentId,
        streamId: params.streamId,
        cursor: params.cursor,
        ...(typeof params.maxEvents === 'number' ? { maxEvents: params.maxEvents } : {}),
        ...(params.waitForEvents ? { waitForEvents: true } : {}),
      },
    });
    throwIfRpcError(res);
    const read = ensureOk(res, ExecutionRunTurnStreamReadResponseSchema);
    if (params.waitForEvents && !read.done && read.events.length === 0) {
      // 0.2 fd3f03529d accepts but ignores waitForEvents. Pace its immediate
      // empty replies with the existing read interval; remove when 0.2 daemons
      // leave support. Current daemons hold the read until an event or End.
      const config = resolveVoiceTurnStreamReadConfig(
        readLocalConversationSettingsFromAccountSettings(storage.getState().settings),
      );
      const lifetime = mergeAbortSignals([params.signal, this.lifetimeSignal]);
      try {
        await sleepWithSignal(config.pollIntervalMs, lifetime.signal);
      } finally {
        lifetime.dispose();
      }
    }
    return read;
  }

  async cancelTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string }>): Promise<{ ok: true }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
      payload: { runId: params.voiceAgentId, streamId: params.streamId },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunTurnStreamCancelResponseSchema);
  }

  async commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
      payload: {
        runId: params.voiceAgentId,
        actionId: 'voice_agent.commit',
        input: params.maxChars ? { maxChars: params.maxChars } : undefined,
      },
    });
    throwIfRpcError(res);
    const parsed = ensureOk(res, ExecutionRunActionResponseSchema) as any;
    const commitText = parsed?.result?.commitText;
    if (typeof commitText !== 'string') {
      throw new Error('invalid_rpc_response');
    }
    return { commitText };
  }

  async stop(params: Readonly<{ sessionId: string; voiceAgentId: string; signal?: AbortSignal }>): Promise<{ ok: true }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      signal: params.signal,
      payload: { runId: params.voiceAgentId },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunStopResponseSchema);
  }
}
