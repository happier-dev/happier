import { getAgentCore, isAgentId, type AgentId } from '@/agents/registry/registryCore';
import { normalizeNonEmptyString } from './shared';

export type VoiceInitialMessageCustody = Readonly<{
  initialMessage: string | null;
  initialMessageMetaOverrides: Record<string, unknown> | null;
}>;

export function resolveVoiceInitialMessageCustody(params: Readonly<{
  initialMessage?: string | null;
  agentId?: string | null;
  backendTarget?: Readonly<{ backendId?: unknown }> | null;
  modelId?: string | null;
}>): VoiceInitialMessageCustody {
  const initialMessage = normalizeNonEmptyString(params.initialMessage);
  if (!initialMessage) {
    return {
      initialMessage: null,
      initialMessageMetaOverrides: null,
    };
  }

  const initialMessageMetaOverrides = resolveVoiceInitialMessageMetaOverrides({
    agentId: resolveVoiceSpawnAgentId({
      agentId: params.agentId,
      backendTarget: params.backendTarget,
    }),
    modelId: params.modelId,
  });
  return {
    initialMessage,
    initialMessageMetaOverrides,
  };
}

function resolveVoiceSpawnAgentId(params: Readonly<{
  agentId?: string | null;
  backendTarget?: Readonly<{ backendId?: unknown }> | null;
}>): AgentId | null {
  const requestedAgentId = normalizeNonEmptyString(params.agentId);
  if (requestedAgentId && isAgentId(requestedAgentId)) {
    return requestedAgentId;
  }

  const backendId = typeof params.backendTarget?.backendId === 'string'
    ? normalizeNonEmptyString(params.backendTarget.backendId)
    : null;
  return backendId && isAgentId(backendId) ? backendId : null;
}

function resolveVoiceInitialMessageMetaOverrides(params: Readonly<{
  agentId: AgentId | null;
  modelId?: string | null;
}>): Record<string, unknown> | null {
  const modelId = normalizeNonEmptyString(params.modelId);
  if (!modelId || params.agentId === null) return null;
  if (getAgentCore(params.agentId).model.nonAcpApplyScope !== 'next_prompt') return null;
  return { model: modelId };
}
