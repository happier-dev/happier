import { apiSocket } from '@/sync/api/session/apiSocket';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  VoiceMediatorCommitResponseSchema,
  VoiceMediatorSendTurnResponseSchema,
  VoiceMediatorStartResponseSchema,
  VoiceMediatorStopResponseSchema,
  VoiceMediatorGetModelsResponseSchema,
} from '@happier-dev/protocol';

import type { VoiceMediatorClient, VoiceMediatorStartParams, VoiceMediatorStartResult } from './types';

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
}

export class DaemonMediatorClient implements VoiceMediatorClient {
  async start(params: VoiceMediatorStartParams): Promise<VoiceMediatorStartResult> {
    const res: any = await apiSocket.sessionRPC(params.sessionId, SESSION_RPC_METHODS.VOICE_MEDIATOR_START, {
      agentSource: params.agentSource,
      agentId: params.agentId,
      verbosity: params.verbosity,
      chatModelId: params.chatModelId,
      commitModelId: params.commitModelId,
      permissionPolicy: params.permissionPolicy,
      idleTtlSeconds: params.idleTtlSeconds,
      initialContext: params.initialContext,
    });
    throwIfRpcError(res);
    return ensureOk(res, VoiceMediatorStartResponseSchema);
  }

  async sendTurn(params: Readonly<{ sessionId: string; mediatorId: string; userText: string }>): Promise<{ assistantText: string }> {
    const res: any = await apiSocket.sessionRPC(params.sessionId, SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN, {
      mediatorId: params.mediatorId,
      userText: params.userText,
    });
    throwIfRpcError(res);
    return ensureOk(res, VoiceMediatorSendTurnResponseSchema);
  }

  async commit(params: Readonly<{ sessionId: string; mediatorId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }> {
    const res: any = await apiSocket.sessionRPC(params.sessionId, SESSION_RPC_METHODS.VOICE_MEDIATOR_COMMIT, {
      mediatorId: params.mediatorId,
      kind: params.kind,
      constraints: params.maxChars ? { maxChars: params.maxChars } : undefined,
    });
    throwIfRpcError(res);
    return ensureOk(res, VoiceMediatorCommitResponseSchema);
  }

  async stop(params: Readonly<{ sessionId: string; mediatorId: string }>): Promise<{ ok: true }> {
    const res: any = await apiSocket.sessionRPC(params.sessionId, SESSION_RPC_METHODS.VOICE_MEDIATOR_STOP, {
      mediatorId: params.mediatorId,
    });
    throwIfRpcError(res);
    return ensureOk(res, VoiceMediatorStopResponseSchema);
  }

  async getModels(params: Readonly<{ sessionId: string }>): Promise<{ availableModels: Array<{ id: string; name: string; description?: string }>; supportsFreeform: boolean }> {
    const res: any = await apiSocket.sessionRPC(params.sessionId, SESSION_RPC_METHODS.VOICE_MEDIATOR_GET_MODELS, {});
    throwIfRpcError(res);
    const parsed = ensureOk(res, VoiceMediatorGetModelsResponseSchema);
    return { availableModels: parsed.availableModels, supportsFreeform: parsed.supportsFreeform };
  }
}
