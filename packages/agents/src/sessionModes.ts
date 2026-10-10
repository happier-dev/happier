import type { AgentId } from './types.js';
import type { AgentRuntimeModeSwitchKind } from './advancedModes.js';

export type AgentSessionModesKind = 'none' | 'acpPolicyPresets' | 'acpAgentModes' | 'staticAgentModes';

export type AgentSessionModeSource = 'none' | 'acp' | 'provider-native';

export type AgentSessionModeSemantics = 'none' | 'policy-presets' | 'agent-modes';

export type AgentAcpSessionModeSetMethod = 'set_mode' | 'config_option';

export type AgentSessionModeDescriptor = Readonly<{
  source: AgentSessionModeSource;
  semantics: AgentSessionModeSemantics;
  runtimeSwitch: AgentRuntimeModeSwitchKind;
  acpModeConfigOptionId?: string;
  acpModeSetMethod?: AgentAcpSessionModeSetMethod;
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
  qwen: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  kimi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  kilo: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  kiro: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  devin: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  customAcp: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  pi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  copilot: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  cursor: {
    source: 'acp',
    semantics: 'agent-modes',
    runtimeSwitch: 'acp-config-option',
    acpModeConfigOptionId: 'mode',
    acpModeSetMethod: 'config_option',
  },
  grok: {
    source: 'none',
    semantics: 'none',
    runtimeSwitch: 'none',
  },
  // Agy modes (if any) come from negotiated ACP state, not a static descriptor.
  agy: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  fx: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  droid: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  codebuddy: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
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
  devin: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.devin),
  customAcp: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.customAcp),
  pi: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.pi),
  copilot: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.copilot),
  cursor: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.cursor),
  grok: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.grok),
  agy: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.agy),
  fx: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.fx),
  droid: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.droid),
  codebuddy: descriptorToSessionModesKind(AGENT_SESSION_MODE_DESCRIPTORS.codebuddy),
});

export function getAgentSessionModeDescriptor(agentId: AgentId): AgentSessionModeDescriptor {
  return AGENT_SESSION_MODE_DESCRIPTORS[agentId];
}

export function getAgentSessionModesKind(agentId: AgentId): AgentSessionModesKind {
  return descriptorToSessionModesKind(getAgentSessionModeDescriptor(agentId));
}
