import type { AgentId } from './types.js';
import type { AgentRuntimeModeSwitchKind } from './advancedModes.js';

export type AgentSessionModesKind = 'none' | 'acpPolicyPresets' | 'acpAgentModes' | 'staticAgentModes';

export type AgentSessionModeSource = 'none' | 'acp' | 'provider-native';

export type AgentSessionModeSemantics = 'none' | 'policy-presets' | 'agent-modes';

export type AgentSessionModeDescriptor = Readonly<{
  source: AgentSessionModeSource;
  semantics: AgentSessionModeSemantics;
  runtimeSwitch: AgentRuntimeModeSwitchKind;
}>;

/**
 * Session mode surfacing intent for each agent.
 *
 * This is shared between CLI + UI so we can:
 * - keep deprecated alias mapping consistent (`--permission-mode plan` → `--agent-mode plan`)
 * - avoid duplicating “does this agent expose ACP modes?” logic across packages
 */
export const AGENT_SESSION_MODE_DESCRIPTORS: Readonly<Record<AgentId, AgentSessionModeDescriptor>> = Object.freeze({
  claude: { source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native' },
  codex: { source: 'acp', semantics: 'policy-presets', runtimeSwitch: 'metadata-gating' },
  opencode: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  gemini: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  auggie: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  qwen: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  kimi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  kilo: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  kiro: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  customAcp: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  pi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  copilot: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
});

function descriptorToSessionModesKind(descriptor: AgentSessionModeDescriptor): AgentSessionModesKind {
  if (descriptor.source === 'provider-native' && descriptor.semantics === 'agent-modes') {
    return 'staticAgentModes';
  }
  if (descriptor.source === 'acp' && descriptor.semantics === 'agent-modes') {
    return 'acpAgentModes';
  }
  if (descriptor.source === 'acp' && descriptor.semantics === 'policy-presets') {
    return 'acpPolicyPresets';
  }
  return 'none';
}

export const AGENT_SESSION_MODES: Readonly<Record<AgentId, AgentSessionModesKind>> = Object.freeze({
  claude: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.claude),
  codex: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.codex),
  opencode: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.opencode),
  gemini: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.gemini),
  auggie: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.auggie),
  qwen: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.qwen),
  kimi: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.kimi),
  kilo: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.kilo),
  kiro: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.kiro),
  customAcp: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.customAcp),
  pi: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.pi),
  copilot: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.copilot),
});

export function getAgentSessionModeDescriptor(agentId: AgentId): AgentSessionModeDescriptor {
  return AGENT_SESSION_MODE_DESCRIPTORS[agentId];
}

export function getAgentSessionModesKind(agentId: AgentId): AgentSessionModesKind {
  return descriptorToSessionModesKind(getAgentSessionModeDescriptor(agentId));
}
