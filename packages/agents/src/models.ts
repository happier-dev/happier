import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';

export type AgentModelNonAcpApplyScope = 'spawn_only' | 'next_prompt';
export type AgentModelOptionValueId = string;
export type AgentModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: AgentModelOptionValueId;
  options?: ReadonlyArray<Readonly<{
    value: AgentModelOptionValueId;
    name: string;
    description?: string;
  }>>;
}>;
export type AgentModelDescriptor = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  /**
   * Optional extended-context model-id VARIANT for this model (e.g. Claude `<id>[1m]`).
   *
   * Present only when the larger context window is genuinely opt-in for the model; the UI
   * publishes the variant id through the normal model-override pipeline. Always-on
   * extended-context models declare no variant (there is nothing to toggle).
   */
  extendedContextModelId?: string;
  modelOptions?: readonly AgentModelOption[];
}>;

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
  acpModelConfigOptionId?: string;
  /**
   * Controls whether Happy should attempt dynamic model probing for this provider.
   *
   * - `auto`: best-effort dynamic probing (CLI command and/or ACP session)
   * - `static-only`: skip dynamic probing and use catalog defaults only
   */
  dynamicProbe?: 'auto' | 'static-only';
  defaultMode: string;
  allowedModes: readonly string[];
  staticModels?: readonly AgentModelDescriptor[];
}>;

const GEMINI_STATIC_MODELS = Object.freeze([
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Best for complex reasoning, coding, and longer-running tasks.',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Fast, balanced Gemini model for general-purpose work.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    description: 'Lowest-latency Gemini 2.5 option for lightweight prompts.',
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    description: 'Preview flash model from the Gemini 3 generation.',
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    description: 'Preview pro model with stronger reasoning and coding depth.',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    description: 'Latest Gemini 3.1 preview with the strongest reasoning in this static list.',
  },
] satisfies readonly AgentModelDescriptor[]);

const CODEX_STATIC_MODELS = Object.freeze([
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    description: 'Latest frontier agentic coding model.',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini',
    description: 'Smaller frontier agentic coding model.',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT 5.3 Codex',
    description: 'Frontier Codex-optimized agentic coding model.',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT 5.3 Codex Spark',
    description: 'Ultra-fast coding model.',
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT 5.2 Codex',
    description: 'Frontier agentic coding model.',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT 5.2',
    description: 'Optimized for professional work and long-running agents.',
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT 5.1 Codex Max',
    description: 'Codex-optimized model for deep and fast reasoning.',
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT 5.1 Codex Mini',
    description: 'Optimized for codex. Cheaper, faster, but less capable.',
  },
] satisfies readonly AgentModelDescriptor[]);

const AUTHORED_AGENT_MODEL_CONFIG = Object.freeze({
  codex: {
    supportsSelection: true,
    nonAcpApplyScope: 'spawn_only',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: [
      ...CODEX_STATIC_MODELS.map((model) => model.id),
    ],
    staticModels: CODEX_STATIC_MODELS,
  },
  gemini: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'restart_session',
    acpModelConfigOptionId: 'model',
    defaultMode: 'gemini-2.5-pro',
    allowedModes: [
      ...GEMINI_STATIC_MODELS.map((model) => model.id),
    ],
    staticModels: GEMINI_STATIC_MODELS,
  },
  auggie: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  qwen: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  kimi: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  kilo: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  kiro: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'static-only',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  cursor: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'composer-2.5-fast',
    allowedModes: ['composer-2.5-fast'],
    staticModels: [{
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 Fast',
      description: 'Cursor Composer 2.5 fast model, discovered dynamically when the Cursor CLI is available.',
    }],
  },
  ohMyPi: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  pi: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  copilot: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
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
