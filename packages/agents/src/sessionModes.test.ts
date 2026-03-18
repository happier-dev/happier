import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import {
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

  it('keeps the structured descriptor defined for every canonical agent', () => {
    for (const agentId of AGENT_IDS) {
      expect(getAgentSessionModeDescriptor(agentId)).toBeDefined();
    }
  });
});
