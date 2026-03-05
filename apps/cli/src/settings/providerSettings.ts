import type { AgentId } from '@happier-dev/agents';
import { getProviderSettingsDefinition } from '@happier-dev/agents';

export function resolveProviderOutgoingMessageMetaExtras(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
  session: unknown;
}>): Record<string, unknown> {
  const def = getProviderSettingsDefinition(params.agentId);
  if (!def?.buildOutgoingMessageMetaExtras) return {};
  try {
    const extras = def.buildOutgoingMessageMetaExtras({
      agentId: params.agentId,
      settings: params.settings,
      session: params.session,
    }) as unknown;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return {};
    return extras as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function resolveProviderSpawnExtras(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  const def = getProviderSettingsDefinition(params.agentId);
  if (!def?.resolveSpawnExtras) return {};

  try {
    const extras = def.resolveSpawnExtras({ agentId: params.agentId, settings: params.settings }) as unknown;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return {};
    return extras as Record<string, unknown>;
  } catch {
    return {};
  }
}
