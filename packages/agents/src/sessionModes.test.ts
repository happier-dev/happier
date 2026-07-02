import { describe, expect, it } from 'vitest';

import { AGENT_IDS, AGENT_PROVIDER_IDS } from './types.js';
import { legacyCustomAcpCompat } from './index.js';
import {
  AGENT_SESSION_MODE_DESCRIPTORS,
  AGENT_SESSION_MODES,
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  getAgentSessionModeDescriptor,
  getAgentSessionModesKind,
} from './sessionModes.js';
import { getAgentAdvancedModeCapabilities } from './advancedModes.js';

describe('sessionModes', () => {
  it('exposes structured session mode descriptors for representative agents', () => {
    expect(getAgentSessionModeDescriptor('claude')).toEqual({
      source: 'provider-native',
      semantics: 'agent-modes',
      runtimeSwitch: 'provider-native',
    });

    expect(getAgentSessionModeDescriptor('opencode')).toEqual({
      source: 'acp',
      semantics: 'agent-modes',
      runtimeSwitch: 'acp-setSessionMode',
    });

    expect(getAgentSessionModeDescriptor('codex')).toEqual({
      source: 'acp',
      semantics: 'policy-presets',
      runtimeSwitch: 'metadata-gating',
    });

    expect(getAgentSessionModeDescriptor('gemini')).toEqual({
      source: 'none',
      semantics: 'none',
      runtimeSwitch: 'none',
    });
  });

  it('keeps flat compatibility shims aligned with the structured descriptor', () => {
    expect(getAgentSessionModesKind('claude')).toBe('staticAgentModes');
    expect(getAgentSessionModesKind('opencode')).toBe('acpAgentModes');
    expect(getAgentSessionModesKind('codex')).toBe('acpPolicyPresets');
    expect(getAgentSessionModesKind('gemini')).toBe('none');
  });

  it('drives advanced mode runtime-switch capabilities from the shared descriptor', () => {
    expect(getAgentAdvancedModeCapabilities('claude').supportsRuntimeModeSwitch).toBe('provider-native');
    expect(getAgentAdvancedModeCapabilities('opencode').supportsRuntimeModeSwitch).toBe('acp-setSessionMode');
    expect(getAgentAdvancedModeCapabilities('codex').supportsRuntimeModeSwitch).toBe('metadata-gating');
    expect(getAgentAdvancedModeCapabilities('gemini').supportsRuntimeModeSwitch).toBe('none');
  });

  it('keeps the shared session-mode artifacts canonical-only while serving compat lookups explicitly', () => {
    expect(Object.keys(AGENT_SESSION_MODE_DESCRIPTORS).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
    expect(Object.keys(AGENT_SESSION_MODES).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
    for (const agentId of AGENT_IDS) {
      expect(getAgentSessionModeDescriptor(agentId)).toBeDefined();
    }
  });

  it('keeps legacy customAcp out of the canonical session-mode artifacts', () => {
    expect(Object.keys(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
    expect(Object.keys(CANONICAL_AGENT_SESSION_MODES).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
    expect(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_SESSION_MODES).not.toHaveProperty('customAcp');
    expect(AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpSessionModeDescriptor()).toEqual({
      source: 'acp',
      semantics: 'agent-modes',
      runtimeSwitch: 'acp-setSessionMode',
    });
  });
});
