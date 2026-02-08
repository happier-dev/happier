import type { AgentId } from './types.js';

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
  defaultMode: string;
  allowedModes: readonly string[];
}>;

export const AGENT_MODEL_CONFIG: Readonly<Record<AgentId, AgentModelConfig>> = Object.freeze({
  claude: {
    supportsSelection: true,
    supportsFreeform: true,
    nonAcpApplyScope: 'next_prompt',
    defaultMode: 'default',
    allowedModes: [
      // Static suggestions for Claude Code. Availability can vary by plan/workspace,
      // so we keep freeform enabled and treat this list as a convenience menu.

      // Latest (as per Claude Code support docs; snapshot IDs may be preferred in CLI UX).
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-0',
      'claude-sonnet-4-20250514',

      // Common Anthropic API aliases / older IDs users may already have persisted.
      'claude-opus-4-1',
      'claude-opus-4-1-20250805',
      'claude-opus-4-0',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-haiku',
      'claude-3-haiku-20240307',
    ],
  },
  codex: {
    supportsSelection: true,
    nonAcpApplyScope: 'spawn_only',
    acpModelConfigOptionId: 'model',
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
    nonAcpApplyScope: 'next_prompt',
    acpApplyBehavior: 'restart_session',
    acpModelConfigOptionId: 'model',
    defaultMode: 'gemini-2.5-pro',
    allowedModes: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
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
    defaultMode: 'default',
    allowedModes: ['default'],
  },
  kimi: {
    supportsSelection: true,
    nonAcpApplyScope: 'next_prompt',
    acpModelConfigOptionId: 'model',
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
});

export function getAgentModelConfig(agentId: AgentId): AgentModelConfig {
  return AGENT_MODEL_CONFIG[agentId];
}
