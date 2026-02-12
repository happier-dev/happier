import type { AgentId } from './types.js';

export type AgentSessionModesKind = 'none' | 'acpPolicyPresets' | 'acpAgentModes';

/**
 * Session mode surfacing intent for each agent.
 *
 * This is shared between CLI + UI so we can:
 * - keep deprecated alias mapping consistent (`--permission-mode plan` → `--agent-mode plan`)
 * - avoid duplicating “does this agent expose ACP modes?” logic across packages
 */
export const AGENT_SESSION_MODES: Readonly<Record<AgentId, AgentSessionModesKind>> = Object.freeze({
  claude: 'none',
  codex: 'acpPolicyPresets',
  opencode: 'acpAgentModes',
  gemini: 'none',
  auggie: 'none',
  qwen: 'none',
  kimi: 'none',
  kilo: 'acpAgentModes',
  pi: 'none',
});

export function getAgentSessionModesKind(agentId: AgentId): AgentSessionModesKind {
  return AGENT_SESSION_MODES[agentId];
}
