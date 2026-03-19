import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { storage } from '@/sync/domains/state/storage';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  ExecutionRunActionResponseSchema,
  ExecutionRunEnsureOrStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '@happier-dev/protocol';
import type { VoiceAssistantAction } from '@happier-dev/protocol';

import type { VoiceAgentClient, VoiceAgentStartParams, VoiceAgentStartResult, VoiceAgentTurnStreamEvent } from './types';
import { resolveVoiceAgentBootstrapTimeoutMs } from './resolveVoiceAgentBootstrapTimeoutMs';
import { resolveVoiceTurnStreamReadConfig, type VoiceTurnStreamReadConfig } from './resolveVoiceTurnStreamReadConfig';

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

function normalizeVoiceAgentModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

function normalizeVoiceAgentProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class DaemonVoiceAgentClient implements VoiceAgentClient {
  private resolveStartTimeoutMs(params: Readonly<{ bootstrapTimeoutMs?: number }>): number {
    const settings: any = storage.getState().settings;
    const localConversationSettings = settings?.voice?.adapters?.local_conversation ?? null;
    const raw = Number(localConversationSettings?.networkTimeoutMs ?? NaN);
    const networkTimeoutMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000;
    const explicitBootstrapTimeoutMs = Number(params.bootstrapTimeoutMs);
    const bootstrapTimeoutMs =
      Number.isFinite(explicitBootstrapTimeoutMs) && explicitBootstrapTimeoutMs > 0
        ? Math.floor(explicitBootstrapTimeoutMs)
        : (resolveVoiceAgentBootstrapTimeoutMs(localConversationSettings) ?? 0);
    return Math.max(networkTimeoutMs, bootstrapTimeoutMs, 30_000);
  }

  private resolveTurnStreamReadConfig(): VoiceTurnStreamReadConfig {
    const settings: any = storage.getState().settings;
    const voiceCfg = settings?.voice?.adapters?.local_conversation ?? null;
    return resolveVoiceTurnStreamReadConfig(voiceCfg);
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    const backendId = String(params.agentId ?? '').trim() || 'claude';
    const chatModelId = normalizeVoiceAgentModelId(params.chatModelId);
    const commitModelId = normalizeVoiceAgentModelId(params.commitModelId);
    const profileId = normalizeVoiceAgentProfileId(params.profileId);
    const startPayload = {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: backendId },
      permissionMode: params.permissionPolicy,
      retentionPolicy: params.retentionPolicy ?? 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      ...(params.resumeHandle ? { resumeHandle: params.resumeHandle } : {}),
      ...(chatModelId ? { chatModelId } : {}),
      ...(commitModelId ? { commitModelId } : {}),
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
      const res: any = await sessionRpcWithServerScope({
        sessionId: params.sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
        timeoutMs: this.resolveStartTimeoutMs({ bootstrapTimeoutMs: params.bootstrapTimeoutMs }),
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
        return await ensureOrStart();
      }
      throw error;
    }
  }

  async sendTurn(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    const readCfg = this.resolveTurnStreamReadConfig();
    const started = await this.startTurnStream({
      sessionId: params.sessionId,
      voiceAgentId: params.voiceAgentId,
      userText: params.userText,
      ...(typeof params.displayUserText === 'string' ? { displayUserText: params.displayUserText } : {}),
    });
    let cursor = 0;
    const startedAt = Date.now();
    let merged = '';

    for (;;) {
      const read = await this.readTurnStream({
        sessionId: params.sessionId,
        voiceAgentId: params.voiceAgentId,
        streamId: started.streamId,
        cursor,
        maxEvents: readCfg.maxEvents,
      });
      cursor = read.nextCursor;
      for (const event of read.events) {
        if (event.t === 'delta') merged += event.textDelta;
        if (event.t === 'done') {
          return { assistantText: event.assistantText, actions: event.actions ?? [] };
        }
        if (event.t === 'error') {
          throw createRpcCallError({ error: event.error, errorCode: event.errorCode });
        }
      }
      if (read.done) {
        return { assistantText: merged.trim(), actions: [] };
      }
      if (readCfg.streamTimeoutMs !== null && Date.now() - startedAt > readCfg.streamTimeoutMs) {
        await this.cancelTurnStream({ sessionId: params.sessionId, voiceAgentId: params.voiceAgentId, streamId: started.streamId }).catch(() => {});
        throw new Error('stream_timeout');
      }
      await new Promise((r) => setTimeout(r, readCfg.pollIntervalMs));
    }
  }

  async welcome(params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>): Promise<{ assistantText: string }> {
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      payload: {
        runId: params.voiceAgentId,
        actionId: 'voice_agent.welcome',
        ...(typeof params.welcomeText === 'string' && params.welcomeText.trim().length > 0
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

  async startTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string; resume?: boolean }>): Promise<{ streamId: string }> {
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      payload: {
        runId: params.voiceAgentId,
        message: params.userText,
        ...(typeof params.displayUserText === 'string' && params.displayUserText.trim().length > 0
          ? { displayMessage: params.displayUserText }
          : {}),
        ...(params.resume === true ? { resume: true } : {}),
      },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunTurnStreamStartResponseSchema);
  }

  async readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }> {
    const res: any = await sessionRpcWithServerScope({
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
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      payload: { runId: params.voiceAgentId, streamId: params.streamId },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunTurnStreamCancelResponseSchema);
  }

  async commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }> {
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
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
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      payload: { runId: params.voiceAgentId },
    });
    throwIfRpcError(res);
    return ensureOk(res, ExecutionRunStopResponseSchema);
  }
}
