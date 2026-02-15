import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
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

function ensureOk<T>(
  value: unknown,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown } },
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
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

export class DaemonVoiceAgentClient implements VoiceAgentClient {
  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    const backendId = String(params.agentId ?? '').trim() || 'claude';
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      payload: {
        runId: typeof params.existingRunId === 'string' ? params.existingRunId : null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendId,
          permissionMode: params.permissionPolicy,
          retentionPolicy: params.retentionPolicy ?? 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'streaming',
          ...(params.resumeHandle ? { resumeHandle: params.resumeHandle } : {}),
          // passthrough configuration consumed by the voice_agent intent runtime
          chatModelId: params.chatModelId,
          commitModelId: params.commitModelId,
          idleTtlSeconds: params.idleTtlSeconds,
          initialContext: params.initialContext,
          verbosity: params.verbosity,
          ...(params.transcript ? { transcript: params.transcript } : {}),
        },
      },
    });
    throwIfRpcError(res);
    const parsed = ensureOk(res, ExecutionRunEnsureOrStartResponseSchema);
    return { voiceAgentId: parsed.runId };
  }

  async sendTurn(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    const started = await this.startTurnStream({ sessionId: params.sessionId, voiceAgentId: params.voiceAgentId, userText: params.userText });
    let cursor = 0;
    const startedAt = Date.now();
    const timeoutMs = 30_000;
    const pollMs = 25;
    let merged = '';

    for (;;) {
      const read = await this.readTurnStream({
        sessionId: params.sessionId,
        voiceAgentId: params.voiceAgentId,
        streamId: started.streamId,
        cursor,
        maxEvents: 256,
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
      if (Date.now() - startedAt > timeoutMs) {
        await this.cancelTurnStream({ sessionId: params.sessionId, voiceAgentId: params.voiceAgentId, streamId: started.streamId }).catch(() => {});
        throw new Error('stream_timeout');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async startTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string }>): Promise<{ streamId: string }> {
    const res: any = await sessionRpcWithServerScope({
      sessionId: params.sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      payload: { runId: params.voiceAgentId, message: params.userText },
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
