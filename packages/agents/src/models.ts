import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import type { AgentModelDescriptor } from '@happier-dev/protocol';

export type {
  AgentModelDescriptor,
  AgentModelOption,
  AgentModelOptionValueId,
} from '@happier-dev/protocol';

export type AgentModelNonAcpApplyScope = 'spawn_only' | 'next_prompt';

export type AgentModelConfig = Readonly<{
  supportsSelection: boolean;
  /**
   * When true, the provider accepts arbitrary model IDs even if we cannot list them.
   *
   * This is intended for CLIs like Claude Code where the set of available models
   * can depend on account state and/or interactive flows.
   */
  supportsFreeform?: boolean;
  /**
   * Optional provider-owned guard for freeform model ids.
   *
   * When absent, `supportsFreeform` means any non-empty model id can be entered.
   * When present, freeform ids must start with one of these prefixes. This keeps
   * provider-scoped remembered selections from preserving stale ids from another
   * provider while still allowing new provider-native model versions.
   */
  freeformModelIdPrefixes?: readonly string[];
  /**
   * How model changes should be described/applied for non-ACP sessions.
   *
   * ACP sessions may support live switching via `session/set_model`; callers should
   * treat those as `live` regardless of this value.
   */
  nonAcpApplyScope: AgentModelNonAcpApplyScope;
  /**
   * ACP-specific model switching behavior hint for UI “effective policy” copy.
   *
   * - set_model: runtime can switch models without restarting the session
   * - restart_session: changing the model requires starting a new underlying session
   */
  acpApplyBehavior?: 'set_model' | 'restart_session';
  /**
   * Optional ACP `session/set_config_option` id to use as a fallback when `session/set_model`
   * is unsupported by the agent.
   *
   * Many agents expose a `model` config option, but this is not guaranteed by ACP.
   */
  acpModelConfigOptionId?: string | null;
  /**
   * Controls whether Happy should attempt dynamic model probing for this provider.
   *
   * - `auto`: best-effort dynamic probing (CLI command and/or ACP session)
   * - `static-only`: skip dynamic probing and use catalog defaults only
   */
  dynamicProbe?: 'auto' | 'static-only';
  defaultMode: string | null;
  allowedModes: readonly string[];
  staticModels?: readonly AgentModelDescriptor[];
}>;

const AUTHORED_AGENT_MODEL_CONFIG = Object.freeze({
} satisfies Partial<Record<CanonicalAgentId, AgentModelConfig>>);

export const CANONICAL_AGENT_MODEL_CONFIG: Readonly<Record<CanonicalAgentId, AgentModelConfig>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentModelConfig>({
    authored: AUTHORED_AGENT_MODEL_CONFIG,
    label: 'model config',
    readGenerated: (definition) => definition.modelConfig,
  });

export const AGENT_MODEL_CONFIG: Readonly<Record<CanonicalAgentId, AgentModelConfig>> = CANONICAL_AGENT_MODEL_CONFIG;

export function getAgentModelConfig(agentId: AgentId): AgentModelConfig {
  return AGENT_MODEL_CONFIG[agentId];
}

export function getAgentStaticModels(agentId: AgentId): readonly AgentModelDescriptor[] {
  const config = getAgentModelConfig(agentId);
  const staticModels = Array.isArray(config.staticModels) && config.staticModels.length > 0
    ? config.staticModels
    : config.allowedModes.map((id) => ({ id, name: id }));

  const seen = new Set<string>();
  return staticModels.filter((model) => {
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export type AgentFreeformModelIdConfig = Readonly<{
  supportsFreeform?: boolean;
  freeformModelIdPrefixes?: readonly string[];
}>;

function normalizeFreeformModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function hasConstrainedFreeformModelIds(modelConfig: AgentFreeformModelIdConfig): boolean {
  return Array.isArray(modelConfig.freeformModelIdPrefixes)
    && modelConfig.freeformModelIdPrefixes.some((prefix) => normalizeFreeformModelId(prefix).length > 0);
}

export function isFreeformModelIdAllowed(
  modelConfig: AgentFreeformModelIdConfig,
  modelId: unknown,
): boolean {
  if (modelConfig.supportsFreeform !== true) return false;
  const normalized = normalizeFreeformModelId(modelId);
  if (!normalized) return false;
  const prefixes = (modelConfig.freeformModelIdPrefixes ?? [])
    .map((prefix) => normalizeFreeformModelId(prefix))
    .filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}
