import { describe, expect, it } from 'vitest';

import * as agents from './index.js';
import { AGENTS_CORE } from './manifest.js';
import { AGENT_IDS } from './types.js';

describe('agent media capabilities', () => {
  it('defines media capability vocabulary for every canonical agent', () => {
    for (const agentId of AGENT_IDS) {
      expect(AGENTS_CORE[agentId].media).toBeDefined();
      expect(AGENTS_CORE[agentId].media.acceptsImageInput).toMatch(/^(supported|experimental|unsupported)$/);
      expect(AGENTS_CORE[agentId].media.emitsSessionMedia).toMatch(/^(supported|experimental|unsupported)$/);
      expect(AGENTS_CORE[agentId].media.nativeImageGeneration).toMatch(/^(supported|experimental|unsupported)$/);
    }
  });

  it('keeps generated media output distinct from prompt image input', () => {
    expect(agents.getAgentMediaCapabilities('claude')).toMatchObject({
      acceptsImageInput: 'supported',
      emitsSessionMedia: 'supported',
      nativeImageGeneration: 'unsupported',
    });

    expect(agents.getAgentMediaCapabilities('codex')).toMatchObject({
      acceptsImageInput: 'supported',
      emitsSessionMedia: 'supported',
      nativeImageGeneration: 'supported',
    });
  });

  it('populates conservative provider media output support', () => {
    expect(agents.getAgentMediaCapability('gemini', 'nativeImageGeneration')).toBe('unsupported');
    expect(agents.getAgentMediaCapability('pi', 'nativeImageGeneration')).toBe('unsupported');
    expect(agents.getAgentMediaCapability('pi', 'emitsSessionMedia')).toBe('experimental');
    expect(agents.getAgentMediaCapability('opencode', 'nativeImageGeneration')).toBe('unsupported');
    expect(agents.getAgentMediaCapability('customAcp', 'emitsSessionMedia')).toBe('supported');
    expect(agents.isAgentMediaCapabilitySupported('customAcp', 'nativeImageGeneration')).toBe(false);
    expect(agents.getAgentMediaCapabilities('grok')).toEqual({
      acceptsImageInput: 'unsupported',
      emitsSessionMedia: 'unsupported',
      nativeImageGeneration: 'unsupported',
    });
  });
});
