import type { AgentId } from './types.js';
import {
  formatClaudeEffortLevelLabel,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeDefaultEffortLevelForModelId,
  resolveClaudeEffortLevelsForModelId,
} from './providers/claude/effort.js';
import {
  isClaude1mContextOptInModelId,
  toClaude1mModelId,
} from './providers/claude/contextWindow.js';

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
   * Provider-declared extended-context variant id (e.g. `claude-sonnet-4-6[1m]`).
   *
   * Present only when the larger context window is genuinely OPT-IN for this model.
   * UIs surface it as a "Context" toggle that switches the effective model id between
   * `id` and this variant through the regular model-override pipeline.
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
   * Runtime ACP method to use when applying a selected model.
   *
   * Defaults to `set_model` with a best-effort config-option fallback. Providers that advertise
   * models through ACP config options but do not reliably honor `session/set_model` should set
   * `config_option` so Happier applies the exact ACP model option value through the provider's
   * model config option.
   */
  acpModelSetMethod?: 'set_model' | 'config_option';
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

/**
 * The Ultracode toggle as the picker renders it.
 *
 * Shared so a model discovered at runtime surfaces the identical control to a curated one; two
 * copies of this copy would drift.
 */
export function buildClaudeUltracodeModelOption(): AgentModelOption {
  return {
    id: 'ultracode',
    name: 'Ultracode',
    description: 'Maximum reasoning with dynamic workflows (forces XHigh effort). Applies to the current session only.',
    type: 'boolean',
    currentValue: 'false',
  };
}

function withClaudeEffortModelOptions(model: AgentModelDescriptor): AgentModelDescriptor {
  const levels = resolveClaudeEffortLevelsForModelId(model.id);
  const currentValue = resolveClaudeDefaultEffortLevelForModelId(model.id);
  if (levels.length === 0 || !currentValue) return model;

  const options = levels.map((level) => ({ value: level, name: formatClaudeEffortLevelLabel(level) }));
  const modelOptions: AgentModelOption[] = [{
    id: 'reasoning_effort',
    name: 'Thinking',
    type: 'select',
    currentValue,
    options,
  }];

  // Ultracode is a session-only Claude Code setting (forces xhigh + Dynamic Workflows),
  // orthogonal to the effort axis — surfaced as a boolean toggle, never a 6th effort pill.
  if (isClaudeUltracodeSupportedModelId(model.id)) {
    modelOptions.push(buildClaudeUltracodeModelOption());
  }

  return { ...model, modelOptions };
}

function withClaude1mContextVariant(model: AgentModelDescriptor): AgentModelDescriptor {
  if (!isClaude1mContextOptInModelId(model.id)) return model;
  return { ...model, extendedContextModelId: toClaude1mModelId(model.id) };
}

const CLAUDE_STATIC_MODELS = Object.freeze(([
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    description: 'Latest highest-capability Claude model for the hardest coding and reasoning tasks.',
    contextWindowTokens: 1_000_000,
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    description: 'Newest highest-capability generally available Claude model for the hardest coding and reasoning tasks.',
    contextWindowTokens: 1_000_000,
  },
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    description: 'Prior highest-capability Claude model for the hardest coding and reasoning tasks.',
    contextWindowTokens: 1_000_000,
  },
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    description: 'Earlier highest-capability Claude model for hard coding and reasoning tasks.',
    contextWindowTokens: 1_000_000,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Opus 4.6',
    description: 'Highest-capability Claude model for the hardest coding and reasoning tasks.',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    description: 'Balanced Claude model for everyday coding, editing, and analysis.',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest Claude option for lighter tasks and lower-latency replies.',
  },
  {
    id: 'claude-opus-4-5',
    name: 'Opus 4.5',
    description: 'Prior Opus generation alias for compatibility with existing Claude setups.',
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Sonnet 4.5',
    description: 'Prior Sonnet generation alias for compatibility with existing Claude setups.',
  },
] satisfies readonly AgentModelDescriptor[]).map(withClaudeEffortModelOptions).map(withClaude1mContextVariant));

const GEMINI_STATIC_MODELS = Object.freeze([
  {
    id: 'auto',
    name: 'Auto',
    description: 'Let Gemini CLI choose the best available model for the request and account.',
  },
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

export const AGENT_MODEL_CONFIG: Readonly<Record<AgentId, AgentModelConfig>> = Object.freeze({
  claude: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    // Augment the curated static catalog with any models the account can run (fetched from the
    // Anthropic Models API in the Claude preflight adapter). Falls back to static on any failure.
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: [
      ...CLAUDE_STATIC_MODELS.map((model) => model.id),
    ],
    staticModels: CLAUDE_STATIC_MODELS,
  },
  codex: {
    supportsSelection: true,
    nonAcpApplyScope: 'spawn_only',
    acpModelConfigOptionId: 'model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  opencode: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  gemini: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'restart_session',
    acpModelConfigOptionId: 'model',
    defaultMode: 'auto',
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
  customAcp: {
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
  cursor: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
    acpModelSetMethod: 'config_option',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  grok: {
    supportsSelection: true,
    supportsFreeform: false,
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'set_model',
    dynamicProbe: 'auto',
    defaultMode: 'default',
    allowedModes: [],
  },
});

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
