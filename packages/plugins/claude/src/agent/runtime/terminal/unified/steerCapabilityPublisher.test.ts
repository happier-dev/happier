import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedSteerCapabilityPublisher } from './steerCapabilityPublisher.js';

function capture() {
  const statuses: Readonly<Record<string, unknown>>[] = [];
  const publishStatus = vi.fn((status: Readonly<Record<string, unknown>>) => { statuses.push(status); });
  const current = () => statuses.at(-1) ?? {};
  return { publishStatus, current, get writes() { return statuses.length; } };
}

const logger = { debug: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe('createClaudeUnifiedSteerCapabilityPublisher (Seam A)', () => {
  it('publishes unsafe_window with a state timestamp while the canonical turn is active', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.current().steerAvailable).toBe(false);
    expect(captured.current().steerUnavailableReason).toBe('unsafe_window');
    expect(captured.current().stateUpdatedAtMs).toBe(1234);
    publisher.dispose();
  });

  it('passes the user_terminal_draft starvation reason through while the canonical turn is active (X1)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.current().steerAvailable).toBe(false);
    expect(captured.current().steerUnavailableReason).toBe('user_terminal_draft');
    expect(captured.current().terminalComposerClearSupported).toBe(true);
    expect(captured.current().terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('publishes composer clear support and clears draft presence on non-draft snapshots', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.current().terminalComposerClearSupported).toBe(true);
    expect(captured.current().terminalComposerDraftPresent).toBe(false);
    publisher.dispose();
  });

  it('dedupes on raw composer draft presence, not only the public unavailable reason', () => {
    const captured = capture();
    let canonicalActive = false;
    let now = 100;
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => canonicalActive,
      nowMs: () => now,
      minPublishIntervalMs: 0,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });
    now = 200;
    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.writes).toBe(2);
    expect(captured.current().steerUnavailableReason).toBe('turn_settling');
    expect(captured.current().terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('maps an unavailable snapshot to turn_settling when the canonical turn is no longer active', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => false,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.current().steerUnavailableReason).toBe('turn_settling');
    publisher.dispose();
  });

  it('clears the reason and de-duplicates identical snapshots', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });

    expect(captured.writes).toBe(1);
    expect(captured.current().steerAvailable).toBe(true);
    expect(captured.current().steerUnavailableReason ?? null).toBeNull();
    publisher.dispose();
  });

  it('rate-limits flapping snapshots with a trailing converging write', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
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
    expect(captured.current().steerAvailable).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(captured.writes).toBe(2);
    expect(captured.current().steerAvailable).toBe(false);
    expect(captured.current().steerUnavailableReason).toBe('unsafe_window');
    publisher.dispose();
  });

  it('publishes the static inFlightConfigApplySupported capability at creation when enabled (lane Q)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
      minPublishIntervalMs: 1000,
      inFlightConfigApplySupported: true,
    });

    // Static capability lands immediately — the UI gate must open before the first steer snapshot.
    expect(captured.writes).toBe(1);
    expect(captured.current().inFlightConfigurationApplySupported).toBe(true);

    // The static write must not consume the snapshot dedup/rate-limit budget: the first
    // steer snapshot still writes immediately and carries the static capability along.
    publisher.publish({ available: false, reason: 'unsafe_window' });
    expect(captured.writes).toBe(2);
    expect(captured.current().steerUnavailableReason).toBe('unsafe_window');
    expect(captured.current().inFlightConfigurationApplySupported).toBe(true);
    publisher.dispose();
  });

  it('never writes inFlightConfigApplySupported when the capability is disabled (fail-closed)', () => {
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    expect(captured.writes).toBe(0);
    publisher.publish({ available: true, reason: null });
    expect(captured.writes).toBe(1);
    expect(captured.current().inFlightConfigurationApplySupported).toBe(false);
    publisher.dispose();
  });

  it('dispose cancels a scheduled trailing publication', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeUnifiedSteerCapabilityPublisher({
      publishStatus: captured.publishStatus,
      logger,
      isCanonicalTurnActive: () => true,
      minPublishIntervalMs: 1000,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });
    publisher.dispose();
    vi.advanceTimersByTime(2000);
    expect(captured.writes).toBe(1);

  });
});
