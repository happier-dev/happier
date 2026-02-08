import type { AgentId } from './types.js';
import { getAgentSessionModesKind } from './sessionModes.js';

export type AgentRuntimeModeSwitchKind = 'none' | 'metadata-gating' | 'acp-setSessionMode' | 'provider-native';

export type AgentAdvancedModeCapabilities = Readonly<{
  /**
   * Whether this agent can surface a user-facing “plan mode” concept at all.
   *
   * Note: for ACP agents this represents the *possibility* of a plan-like mode;
   * the concrete set of available modes is discovered dynamically from ACP metadata.
   */
  supportsPlanMode: boolean;
  /**
   * Whether this agent supports a distinct “accept edits”/auto-approve edits concept.
   *
   * Today this is a Claude-specific native permission token.
   */
  supportsAcceptEdits: boolean;
  /**
   * Best-effort description of how runtime mode/permission changes are applied without
   * restarting the underlying session.
   *
   * This is intentionally coarse-grained; specific sessions may still be more limited.
   */
  supportsRuntimeModeSwitch: AgentRuntimeModeSwitchKind;
}>;

export function getAgentAdvancedModeCapabilities(agentId: AgentId): AgentAdvancedModeCapabilities {
  const sessionModesKind = getAgentSessionModesKind(agentId);
  const supportsPlanMode = agentId === 'claude' || sessionModesKind === 'acpAgentModes';
  const supportsAcceptEdits = agentId === 'claude';

  const supportsRuntimeModeSwitch: AgentRuntimeModeSwitchKind =
    sessionModesKind === 'acpAgentModes'
      ? 'acp-setSessionMode'
      : agentId === 'claude'
        ? 'provider-native'
        : 'metadata-gating';

  return { supportsPlanMode, supportsAcceptEdits, supportsRuntimeModeSwitch };
}

