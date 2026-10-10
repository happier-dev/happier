import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunStopResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema, ExecutionRunUserTranscriptCommitResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import type { ExecutionRunUserTranscriptDirective, VoiceAssistantAction } from '@happier-dev/protocol';

import type { VoiceAgentClient, VoiceAgentStartParams, VoiceAgentStartResult, VoiceAgentTurnStreamEvent } from './types';
import { streamVoiceAgentTurn } from './streamVoiceAgentTurn';
import { requiresProviderSafeModelSelectionRpc } from '@/sync/ops/providerDaemonSessionCompatibility';
import { requiresProviderSafeExecutionRunStartRpc } from '@happier-dev/protocol/execution/runs/startRequest';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';

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

function throwIfRpcError(value: any): void {
  if (value && typeof value === 'object' && typeof value.error === 'string') {
    throw createRpcCallError({ error: value.error, errorCode: value.errorCode });
  }
  if (value && typeof value === 'object' && (value as any).ok === false && typeof (value as any).error === 'string') {
    throw createRpcCallError({ error: String((value as any).error), errorCode: (value as any).errorCode });
  }
}

function normalizeVoiceAgentModelId(value: unknown, preserveDefault = false): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (!preserveDefault && trimmed === 'default')) return null;
  return trimmed;
}

function normalizeVoiceAgentProfileId(value: unknown): string | null {
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
  constructor(private readonly scope: ServerAccountScope) {}

  private sessionRpc<R, A>(params: Readonly<{
    sessionId: string;
    method: string;
    payload: A;
    timeoutMs?: number | null;
  }>): Promise<R> {
    return sessionRpcWithServerAccountScope<R, A>({ ...params, scope: this.scope });
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    const backendId = String(params.agentId ?? '').trim();
    if (!backendId) {
      throw Object.assign(new Error('voice_agent_selection_unavailable'), {
        code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
      });
    }
    const chatModelId = normalizeVoiceAgentModelId(params.chatModelId);
    const commitModelId = normalizeVoiceAgentModelId(params.commitModelId, true);
    const profileId = normalizeVoiceAgentProfileId(params.profileId);
    const chatModelSelection = params.chatModelSelection ?? (chatModelId
      ? { agentTargetKey: buildAgentUniverseBackendTargetKey(backendId), providerConnectionId: null, modelId: chatModelId }
      : params.chatModelId?.trim() === 'default' ? null : undefined);
    const commitModelSelection = params.commitModelSelection;
    const ensureOrStartMethod = requiresProviderSafeExecutionRunStartRpc({ modelSelection: chatModelSelection }, true)
      || requiresProviderSafeModelSelectionRpc(chatModelSelection, commitModelSelection)
      ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1
      : SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START;
    const startPayload = {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: backendId },
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
      ...(params.commitIsolation === true ? { commitIsolation: true } : {}),
      ...(profileId ? { profileId } : {}),
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
      return { voiceAgentId: parsed.runId };
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
    }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    // The non-streaming daemon turn shares the single canonical turn read-loop. We omit
    // No output observer is needed in this non-streaming path, but reuse the same
    // poll / timeout / abort / cancel semantics from streamVoiceAgentTurn so there is exactly
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
      ...((params.signal || params.userTranscript || params.onUserTranscriptAccepted) ? {
        options: {
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.userTranscript ? { userTranscript: params.userTranscript } : {}),
          ...(params.onUserTranscriptAccepted
            ? { onUserTranscriptAccepted: params.onUserTranscriptAccepted }
            : {}),
        },
      } : {}),
    });
  }

  async welcome(params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>): Promise<{ assistantText: string }> {
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
    const parsed = ensureOk(res, ExecutionRunActionResponseSchema) as any;
    const assistantText = parsed?.result?.assistantText;
    if (typeof assistantText !== 'string') {
      throw new Error('invalid_rpc_response');
    }
    return { assistantText };
  }

  async startTurnStream(params: Readonly<{
    sessionId: string;
    voiceAgentId: string;
    userText: string;
    displayUserText?: string;
    speechSegmentTargetChars?: number;
    resume?: boolean;
    userTranscript?: ExecutionRunUserTranscriptDirective;
  }>): Promise<{ streamId: string }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: params.userTranscript
        ? SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
        : SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      timeoutMs: VOICE_AGENT_LIFECYCLE_RPC_TIMEOUT_MS,
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
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
      payload: {
        runId: params.voiceAgentId,
        streamId: params.streamId,
        cursor: params.cursor,
        ...(typeof params.maxEvents === 'number' ? { maxEvents: params.maxEvents } : {}),
      },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunTurnStreamReadResponseSchema) as any;
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

  async stop(params: Readonly<{ sessionId: string; voiceAgentId: string }>): Promise<{ ok: true }> {
    const res: any = await this.sessionRpc({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      payload: { runId: params.voiceAgentId },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunStopResponseSchema);
  }
}
