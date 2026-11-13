import { describe, expect, it } from 'vitest';

import { PluginAgentSessionCapabilitiesV2Schema, supportsAgentNativeFunctionTools } from './agentSessionCapabilities.js';

const sessions = { open: ['create'], delivery: ['newTurn'], cancel: true };

describe('Agent Session native function declaration', () => {
  it('accepts affirmative native functions and rejects false declarations at admission', () => {
    expect(PluginAgentSessionCapabilitiesV2Schema.parse({ ...sessions, functionTools: true }).functionTools).toBe(true);
    expect(PluginAgentSessionCapabilitiesV2Schema.safeParse({ ...sessions, functionTools: false }).success).toBe(false);
    expect(PluginAgentSessionCapabilitiesV2Schema.parse(sessions)).not.toHaveProperty('functionTools');
  });
  it('requires both native functions and fresh Session creation', () => {
    expect(supportsAgentNativeFunctionTools({ sessions: { open: ['create'], functionTools: true } })).toBe(true);
    for (const capabilities of [undefined, null, {}, { sessions: null }, { sessions: { open: ['create'] } },
      { sessions: { open: ['create'], functionTools: false } }, { sessions: { open: ['resume'], functionTools: true } },
      { sessions: { functionTools: true } }]) {
      expect(supportsAgentNativeFunctionTools(capabilities)).toBe(false);
    }
  });
});

describe('Agent Session compaction declaration', () => {
  it('accepts native and host idle declarations through the contribution boundary', () => {
    for (const idle of [
      { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 0 },
      { mode: 'native', defaultEnabled: true, nativeHonorsMinimum: true, defaultMinContextTokens: 200000 },
      { mode: 'native', defaultEnabled: false },
    ]) {
      const compaction = { events: true, manual: true, idle };
      expect(PluginAgentSessionCapabilitiesV2Schema.parse({ ...sessions, compaction }).compaction).toEqual(compaction);
    }
    expect(PluginAgentSessionCapabilitiesV2Schema.parse({ ...sessions, compaction: { events: true } }).compaction)
      .toEqual({ events: true });
  });

  it('rejects unsupported native minimum defaults and closed-grammar violations', () => {
    for (const compaction of [
      { events: true, manual: 'supported' },
      { events: true, idle: { mode: 'native', defaultEnabled: true, defaultMinContextTokens: 200000 } },
      { events: true, idle: { mode: 'host', defaultEnabled: false, nativeHonorsMinimum: true } },
      { events: true, idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: -1 } },
      { events: true, idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 0.5 } },
      { events: true, idle: { mode: 'native', defaultEnabled: false, cacheWindowMs: 1000 } },
    ]) expect(PluginAgentSessionCapabilitiesV2Schema.safeParse({ ...sessions, compaction }).success).toBe(false);
  });
});
