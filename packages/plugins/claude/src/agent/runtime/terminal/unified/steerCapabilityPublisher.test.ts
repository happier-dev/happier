import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedSteerCapabilityPublisher } from './steerCapabilityPublisher.js';

type AgentStateRecord = Readonly<Record<string, unknown>>;

function capture() {
  let state: AgentStateRecord = {};
  let writes = 0;
  // Boundary fixture: the SDK session.writeAgentState seam is the system boundary here.
  const session = {
    writeAgentState: vi.fn(async (request: { kind: string; handler?: (current: AgentStateRecord) => AgentStateRecord }) => {
      if (request.kind === 'update' && request.handler) {
        writes += 1;
        state = request.handler(state);
      }
    }),
  };
  const capabilities = () => (state.capabilities ?? {}) as Readonly<Record<string, unknown>>;
  return { session, capabilities, get writes() { return writes; } };
}

const logger = { debug: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe('createClaudeUnifiedSteerCapabilityPublisher (Seam A)', () => {
  it('publishes unsafe_window with a state timestamp while the canonical turn is active', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.capabilities().inFlightSteerAvailable).toBe(false);
    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(captured.capabilities().inFlightSteerStateAt).toBe(1234);
    publisher.dispose();
  });

  it('passes the user_terminal_draft starvation reason through while the canonical turn is active (X1)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.capabilities().inFlightSteerAvailable).toBe(false);
    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('user_terminal_draft');
    expect(captured.capabilities().terminalComposerClearSupported).toBe(true);
    expect(captured.capabilities().terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('publishes composer clear support and clears draft presence on non-draft snapshots', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.capabilities().terminalComposerClearSupported).toBe(true);
    expect(captured.capabilities().terminalComposerDraftPresent).toBe(false);
    publisher.dispose();
  });

  it('dedupes on raw composer draft presence, not only the public unavailable reason', () => {
    const captured = capture();
    let canonicalActive = false;
    let now = 100;
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => canonicalActive,
      nowMs: () => now,
      minPublishIntervalMs: 0,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });
    now = 200;
    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.writes).toBe(2);
    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('turn_settling');
    expect(captured.capabilities().terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('maps an unavailable snapshot to turn_settling when the canonical turn is no longer active', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => false,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('turn_settling');
    publisher.dispose();
  });

  it('clears the reason and de-duplicates identical snapshots', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });

    expect(captured.writes).toBe(1);
    expect(captured.capabilities().inFlightSteerAvailable).toBe(true);
    expect(captured.capabilities().inFlightSteerUnavailableReason ?? null).toBeNull();
    publisher.dispose();
  });

  it('rate-limits flapping snapshots with a trailing converging write', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      minPublishIntervalMs: 1000,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });
    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });

    // First write immediate; the flapping follow-ups coalesce into ONE trailing write that
    // converges on the LATEST state.
    expect(captured.writes).toBe(1);
    expect(captured.capabilities().inFlightSteerAvailable).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(captured.writes).toBe(2);
    expect(captured.capabilities().inFlightSteerAvailable).toBe(false);
    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('unsafe_window');
    publisher.dispose();
  });

  it('publishes the static inFlightConfigApplySupported capability at creation when enabled (lane Q)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
      minPublishIntervalMs: 1000,
      inFlightConfigApplySupported: true,
    });

    // Static capability lands immediately — the UI gate must open before the first steer snapshot.
    expect(captured.writes).toBe(1);
    expect(captured.capabilities().inFlightConfigApplySupported).toBe(true);

    // The static write must not consume the snapshot dedup/rate-limit budget: the first
    // steer snapshot still writes immediately and carries the static capability along.
    publisher.publish({ available: false, reason: 'unsafe_window' });
    expect(captured.writes).toBe(2);
    expect(captured.capabilities().inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(captured.capabilities().inFlightConfigApplySupported).toBe(true);
    publisher.dispose();
  });

  it('never writes inFlightConfigApplySupported when the capability is disabled (fail-closed)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    expect(captured.writes).toBe(0);
    publisher.publish({ available: true, reason: null });
    expect(captured.writes).toBe(1);
    expect('inFlightConfigApplySupported' in captured.capabilities()).toBe(false);
    publisher.dispose();
  });

  it('dispose cancels a scheduled trailing write and a missing writeAgentState seam is a safe no-op', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      session: captured.session,
      logger,
      isCanonicalTurnActive: () => true,
      minPublishIntervalMs: 1000,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });
    publisher.dispose();
    vi.advanceTimersByTime(2000);
    expect(captured.writes).toBe(1);

    // Host without the agent-state seam (older host): publishing must never throw.
    const seamless = createClaudeUnifiedSteerCapabilityPublisher({
      session: {},
      logger,
    });
    expect(() => seamless.publish({ available: false, reason: 'unsafe_window' })).not.toThrow();
    seamless.dispose();
  });
});
