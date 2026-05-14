import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';

describe('publishInFlightSteerCapability', () => {
  it('publishes in-flight steer support and active-turn availability', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => true, canSteerPrompt: () => false };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteer).toBe(true);
    expect(state.capabilities?.inFlightSteerSupported).toBe(true);
    expect(state.capabilities?.inFlightSteerAvailable).toBe(false);
  });

  it('publishes inFlightSteer=false when runtime does not support in-flight steer', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = { capabilities: { inFlightSteer: true } as any };
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => false };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteer).toBe(false);
    expect(state.capabilities?.inFlightSteerSupported).toBe(false);
    expect(state.capabilities?.inFlightSteerAvailable).toBe(false);
  });
});
