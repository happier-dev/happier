import type { AgentId, CanonicalAgentId } from './types.js';
import { AGENT_PROVIDER_IDS } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
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
const AUTHORED_AGENT_SESSION_MODE_DESCRIPTORS = Object.freeze({
  claude: { source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native' },
  codex: { source: 'acp', semantics: 'policy-presets', runtimeSwitch: 'metadata-gating' },
  gemini: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  auggie: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  qwen: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  kimi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  kilo: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  kiro: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  cursor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  ohMyPi: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  pi: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },
  copilot: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
} satisfies Partial<Record<CanonicalAgentId, AgentSessionModeDescriptor>>);

export const CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS: Readonly<Record<CanonicalAgentId, AgentSessionModeDescriptor>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentSessionModeDescriptor>({
    authored: AUTHORED_AGENT_SESSION_MODE_DESCRIPTORS,
    label: 'session mode descriptor',
    readGenerated: (definition) => definition.sessionModeDescriptor,
  });

export const AGENT_SESSION_MODE_DESCRIPTORS: Readonly<Record<CanonicalAgentId, AgentSessionModeDescriptor>> = CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS;

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

export const CANONICAL_AGENT_SESSION_MODES: Readonly<Record<CanonicalAgentId, AgentSessionModesKind>> = Object.freeze(
  Object.fromEntries(
    AGENT_PROVIDER_IDS.map((agentId) => [
      agentId,
      descriptorToSessionModesKind(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS[agentId]),
    ]),
  ) as Record<CanonicalAgentId, AgentSessionModesKind>,
);

export const AGENT_SESSION_MODES: Readonly<Record<CanonicalAgentId, AgentSessionModesKind>> = CANONICAL_AGENT_SESSION_MODES;

export function getAgentSessionModeDescriptor(agentId: AgentId): AgentSessionModeDescriptor {
  return AGENT_SESSION_MODE_DESCRIPTORS[agentId];
}

export function getAgentSessionModesKind(agentId: AgentId): AgentSessionModesKind {
  return descriptorToSessionModesKind(getAgentSessionModeDescriptor(agentId));
}
