import { describe, expect, it } from 'vitest';

import * as agents from './index.js';
import { AGENTS_CORE } from './manifest.js';

describe('agent runtime input capability', () => {
  it('declares shared in-flight steer support in the manifest for steer-capable providers', () => {
    expect(Reflect.get(AGENTS_CORE.pi, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: false,
    });
    expect(Reflect.get(AGENTS_CORE.claude, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: true,
    });
    expect(Reflect.get(AGENTS_CORE.grok, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: false,
    });
  });

  it('re-exports the shared in-flight steer helper from the package root', () => {
    expect(Reflect.get(agents, 'supportsAgentInFlightSteer')).toBeTypeOf('function');
    const supportsAgentInFlightSteer = Reflect.get(agents, 'supportsAgentInFlightSteer') as
      | ((agentId: 'pi' | 'claude' | 'grok') => boolean)
      | undefined;
    expect(supportsAgentInFlightSteer?.('pi')).toBe(true);
    expect(supportsAgentInFlightSteer?.('claude')).toBe(true);
    expect(supportsAgentInFlightSteer?.('grok')).toBe(true);
  });

  it('re-exports the shared terminal input injection type surface from the package root', () => {
    expect(Reflect.get(agents, 'supportsAgentTerminalPromptInjection')).toBeTypeOf('function');
    const supportsAgentTerminalPromptInjection = Reflect.get(agents, 'supportsAgentTerminalPromptInjection') as
      | ((agentId: 'pi' | 'claude') => boolean)
      | undefined;
    expect(supportsAgentTerminalPromptInjection?.('pi')).toBe(false);
    expect(supportsAgentTerminalPromptInjection?.('claude')).toBe(true);
  });
});
