import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';

describe('publishInFlightSteerCapability', () => {
  it('publishes inFlightSteer=true when runtime supports in-flight steer', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => true };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any });

    expect(state.capabilities?.inFlightSteer).toBe(true);
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
  });
});

