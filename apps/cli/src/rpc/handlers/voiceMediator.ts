import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  VoiceMediatorCommitRequestSchema,
  VoiceMediatorGetModelsResponseSchema,
  VoiceMediatorSendTurnRequestSchema,
  VoiceMediatorStartRequestSchema,
  VoiceMediatorStopRequestSchema,
  VOICE_MEDIATOR_ERROR_CODES,
} from '@happier-dev/protocol';

import { ClaudeSdkAgentBackend } from '@/agent/claudeSdk/ClaudeSdkAgentBackend';
import { VoiceMediatorError, VoiceMediatorManager } from '@/voice/mediator/VoiceMediatorManager';
import { AGENT_IDS, getAgentModelConfig, type AgentId } from '@happier-dev/agents';
import { createCodexAcpBackend } from '@/backends/codex/acp/backend';
import { createGeminiBackend } from '@/backends/gemini/acp/backend';
import { createOpenCodeBackend } from '@/backends/opencode/acp/backend';
import { createAuggieBackend } from '@/backends/auggie/acp/backend';
import { createQwenBackend } from '@/backends/qwen/acp/backend';
import { createKimiBackend } from '@/backends/kimi/acp/backend';
import { createKiloBackend } from '@/backends/kilo/acp/backend';

import {
  createVoiceMediatorAcpPermissionHandler,
  permissionModeForVoiceMediatorPolicy,
} from '@/voice/mediator/permissionPolicy';

function asRpcError(e: unknown): { error: string; errorCode?: string } {
  if (e instanceof VoiceMediatorError) {
    return { error: e.message, errorCode: e.code };
  }
  if (e instanceof Error) {
    return { error: e.message };
  }
  return { error: 'Unknown error' };
}

function normalizeAgentId(valueRaw: string): AgentId | null {
  const trimmed = String(valueRaw ?? '').trim();
  if (!trimmed) return null;
  return (AGENT_IDS as readonly string[]).includes(trimmed) ? (trimmed as AgentId) : null;
}

export function registerVoiceMediatorHandlers(
  rpc: RpcHandlerManager,
  ctx: Readonly<{ cwd: string; flavor?: string }>,
): void {
  const flavor = typeof ctx.flavor === 'string' ? ctx.flavor : '';

  const manager = new VoiceMediatorManager({
    createBackend: ({ agentId, modelId, permissionPolicy }) => {
      if (agentId === 'claude') {
        return new ClaudeSdkAgentBackend({
          cwd: ctx.cwd,
          modelId,
          permissionPolicy,
        });
      }

      const permissionHandler = createVoiceMediatorAcpPermissionHandler(permissionPolicy);
      const permissionMode = permissionModeForVoiceMediatorPolicy(permissionPolicy);

      if (agentId === 'codex') {
        try {
          return createCodexAcpBackend({ cwd: ctx.cwd, permissionHandler, permissionMode }).backend;
        } catch (e: any) {
          throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', e instanceof Error ? e.message : 'codex unsupported');
        }
      }

      if (agentId === 'gemini') {
        const model = typeof modelId === 'string' && modelId.trim() && modelId.trim() !== 'default' ? modelId.trim() : undefined;
        try {
          return createGeminiBackend({ cwd: ctx.cwd, model: model ?? undefined, permissionHandler }).backend;
        } catch (e: any) {
          throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', e instanceof Error ? e.message : 'gemini unsupported');
        }
      }

      if (agentId === 'opencode') {
        try {
          return createOpenCodeBackend({ cwd: ctx.cwd, permissionHandler, permissionMode });
        } catch (e: any) {
          throw new VoiceMediatorError(
            'VOICE_MEDIATOR_UNSUPPORTED',
            e instanceof Error ? e.message : 'opencode unsupported',
          );
        }
      }

      if (agentId === 'auggie') {
        try {
          return createAuggieBackend({ cwd: ctx.cwd, permissionHandler });
        } catch (e: any) {
          throw new VoiceMediatorError(
            'VOICE_MEDIATOR_UNSUPPORTED',
            e instanceof Error ? e.message : 'auggie unsupported',
          );
        }
      }

      if (agentId === 'qwen') {
        try {
          return createQwenBackend({ cwd: ctx.cwd, permissionHandler });
        } catch (e: any) {
          throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', e instanceof Error ? e.message : 'qwen unsupported');
        }
      }

      if (agentId === 'kimi') {
        try {
          return createKimiBackend({ cwd: ctx.cwd, permissionHandler });
        } catch (e: any) {
          throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', e instanceof Error ? e.message : 'kimi unsupported');
        }
      }

      if (agentId === 'kilo') {
        try {
          return createKiloBackend({ cwd: ctx.cwd, permissionHandler, permissionMode });
        } catch (e: any) {
          throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', e instanceof Error ? e.message : 'kilo unsupported');
        }
      }

      throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', `Unsupported agent: ${agentId}`);
    },
  });

  rpc.registerHandler(SESSION_RPC_METHODS.VOICE_MEDIATOR_START, async (raw: unknown) => {
    const parsed = VoiceMediatorStartRequestSchema.safeParse(raw);
    if (!parsed.success) return { error: 'Invalid params' };

    const agentSource = parsed.data.agentSource ?? 'session';
    const requestedAgentId = agentSource === 'agent' ? String(parsed.data.agentId ?? '').trim() : '';
    const resolvedAgentIdRaw = agentSource === 'agent' ? requestedAgentId : flavor;
    const resolvedAgentId = normalizeAgentId(resolvedAgentIdRaw);

    if (!resolvedAgentId) {
      return {
        error: `Voice mediator (daemon) is not supported for agent: ${resolvedAgentIdRaw || '(missing)'}`,
        errorCode: VOICE_MEDIATOR_ERROR_CODES.UNSUPPORTED,
      };
    }

    try {
      return await manager.start({
        agentId: resolvedAgentId,
        chatModelId: parsed.data.chatModelId,
        commitModelId: parsed.data.commitModelId,
        permissionPolicy: parsed.data.permissionPolicy,
        idleTtlSeconds: parsed.data.idleTtlSeconds,
        initialContext: parsed.data.initialContext,
        verbosity: parsed.data.verbosity,
      });
    } catch (e) {
      return asRpcError(e);
    }
  });

  rpc.registerHandler(SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN, async (raw: unknown) => {
    const parsed = VoiceMediatorSendTurnRequestSchema.safeParse(raw);
    if (!parsed.success) return { error: 'Invalid params' };
    try {
      return await manager.sendTurn({ mediatorId: parsed.data.mediatorId, userText: parsed.data.userText });
    } catch (e) {
      return asRpcError(e);
    }
  });

  rpc.registerHandler(SESSION_RPC_METHODS.VOICE_MEDIATOR_COMMIT, async (raw: unknown) => {
    const parsed = VoiceMediatorCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return { error: 'Invalid params' };
    try {
      const maxChars = parsed.data.constraints?.maxChars;
      return await manager.commit({ mediatorId: parsed.data.mediatorId, maxChars });
    } catch (e) {
      return asRpcError(e);
    }
  });

  rpc.registerHandler(SESSION_RPC_METHODS.VOICE_MEDIATOR_STOP, async (raw: unknown) => {
    const parsed = VoiceMediatorStopRequestSchema.safeParse(raw);
    if (!parsed.success) return { error: 'Invalid params' };
    try {
      return await manager.stop({ mediatorId: parsed.data.mediatorId });
    } catch (e) {
      return asRpcError(e);
    }
  });

  rpc.registerHandler(SESSION_RPC_METHODS.VOICE_MEDIATOR_GET_MODELS, async (_raw: unknown) => {
    const provider = normalizeAgentId(flavor) ?? 'claude';
    const cfg = getAgentModelConfig(provider);
    const supportsFreeform = cfg.supportsSelection === true && cfg.supportsFreeform === true;
    const allowedModes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : [];
    const allowed = cfg.supportsSelection === true ? ['default', ...allowedModes] : ['default'];
    const unique = Array.from(new Set(allowed));
    const response = {
      provider,
      availableModels: unique.map((id) => ({ id, name: id === 'default' ? 'Default' : id })),
      supportsFreeform,
    };
    const parsed = VoiceMediatorGetModelsResponseSchema.safeParse(response);
    if (parsed.success) return parsed.data;
    return response;
  });
}
