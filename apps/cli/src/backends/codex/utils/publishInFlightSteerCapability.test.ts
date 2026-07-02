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

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any, nowMs: () => 1234 });

    expect(state.capabilities?.inFlightSteer).toBe(true);
    expect(state.capabilities?.inFlightSteerSupported).toBe(true);
    expect(state.capabilities?.inFlightSteerAvailable).toBe(false);
    // Seam A: supported-but-unavailable is an unsafe window, stamped for staleness checks.
    expect(state.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(state.capabilities?.inFlightSteerStateAt).toBe(1234);
  });

  it('publishes a null reason when steering is available', async () => {
    const { publishInFlightSteerCapability } = await import('./publishInFlightSteerCapability');

    let state: AgentState = {};
    const session = {
      updateAgentState: (updater: (current: AgentState) => AgentState) => {
        state = updater(state);
      },
    };
    const runtime = { supportsInFlightSteer: () => true, canSteerPrompt: () => true };

    publishInFlightSteerCapability({ session: session as any, runtime: runtime as any, nowMs: () => 99 });

    expect(state.capabilities?.inFlightSteerAvailable).toBe(true);
    expect(state.capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();
    expect(state.capabilities?.inFlightSteerStateAt).toBe(99);
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
    expect(state.capabilities?.inFlightSteerUnavailableReason).toBe('backend_unsupported');
    expect(typeof state.capabilities?.inFlightSteerStateAt).toBe('number');
  });
});
