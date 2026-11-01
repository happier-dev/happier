import { describe, expect, it } from 'vitest';

import { createClaudeNativeRuntime } from './nativeRuntime.js';

describe('Claude selected-mode compaction capability', () => {
  it('returns the captured native capability before Session open', async () => {
    const runtime = createClaudeNativeRuntime({ openSession: async () => { throw new Error('Session must not open during selection'); } });
    const select = runtime.sessions?.resolveTerminalPresentation;
    if (!select) throw new Error('Expected Claude runtime selection');
    // Settings/features are host-service boundaries; this fixture supplies only the selected-method surface.
    const context = {
      features: { isEnabled: () => true },
      settings: { forScope: () => ({ get: async () => false }) },
    } as unknown as Parameters<typeof select>[1];
    const selected = await select({
      runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { backendMode: 'unifiedTerminal' } },
    }, context);
    expect(selected.compaction).toEqual({
      events: true,
      idle: { mode: 'native', defaultEnabled: true, defaultMinContextTokens: 200000, nativeHonorsMinimum: true },
    });
    const sdk = await select({
      runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { backendMode: 'agentSdk' } },
    }, context);
    expect(sdk.compaction).toEqual({
      events: true, manual: true, idle: { mode: 'host', defaultEnabled: true, defaultMinContextTokens: 200000 },
    });
  });
});
