import { describe, expect, it } from 'vitest';

import * as agents from './index.js';
import { AGENTS_CORE } from './manifest.js';

describe('agent runtime input capability', () => {
  it('declares terminal prompt injection separately from generic in-flight steering', () => {
    expect(Reflect.get(AGENTS_CORE.claude, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: true,
    });
    expect(Reflect.get(AGENTS_CORE.pi, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
      terminalPromptInjectionSupported: false,
    });
  });

  it('exports shared runtime-input capability helpers from the package root', () => {
    expect(Reflect.get(agents, 'supportsAgentInFlightSteer')).toBeTypeOf('function');
    expect(Reflect.get(agents, 'supportsAgentTerminalPromptInjection')).toBeTypeOf('function');

    const supportsAgentInFlightSteer = Reflect.get(agents, 'supportsAgentInFlightSteer') as
      | ((agentId: 'claude' | 'opencode' | 'pi') => boolean)
      | undefined;
    const supportsAgentTerminalPromptInjection = Reflect.get(agents, 'supportsAgentTerminalPromptInjection') as
      | ((agentId: 'claude' | 'opencode' | 'pi') => boolean)
      | undefined;

    expect(supportsAgentInFlightSteer?.('claude')).toBe(true);
    expect(supportsAgentTerminalPromptInjection?.('claude')).toBe(true);
    expect(supportsAgentTerminalPromptInjection?.('opencode')).toBe(false);
    expect(supportsAgentTerminalPromptInjection?.('pi')).toBe(false);
  });
});
