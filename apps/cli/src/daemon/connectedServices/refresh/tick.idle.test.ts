import { describe, expect, it, vi } from 'vitest';

import { runConnectedServiceRefreshTick, type ScheduledHealthProbe } from './tick';
import type { ConnectedServiceCredentialRefreshResult, QualifiedConnectedAccountRefreshRuntime } from './ConnectedServiceRefreshCoordinator';
import type { CredentialHealthReprobeState } from './credentialHealthReprobe';

const REFRESH_WINDOW_MS = 10 * 60_000;

/**
 * Drive the refresh loop the way `startSingleFlightIntervalLoop` does: run a tick, then sleep for the
 * returned delay (parked when null). Counts credential observations per idle span.
 */
async function idleFor(spanMs: number, expiresAtFromStart: number | null) {
  const start = 1_000_000;
  let clock = start;
  const maybeRefreshBinding = vi.fn(async (): Promise<ConnectedServiceCredentialRefreshResult> => ({
    status: 'skipped',
    credential: null,
    diagnostic: { expiresAt: expiresAtFromStart === null ? null : start + expiresAtFromStart },
  } as unknown as ConnectedServiceCredentialRefreshResult));
  const scheduledHealthProbeAtByKey = new Map<string, ScheduledHealthProbe>();
  const credentialHealthReprobeState = new Map<string, CredentialHealthReprobeState>();
  const bindings = [
    { serviceId: 'claude-subscription' as const, profileId: 'work' },
    { serviceId: 'openai-codex' as const, profileId: 'home' },
  ];
  const input = {
    now: () => clock,
    refreshWindowMs: REFRESH_WINDOW_MS,
    // The value production passes today (`startDaemonRuntimeBootstrap.ts` refreshTickMs).
    healthProbeIntervalMs: 30_000,
    runtimeRegistry: { listRefreshTargets: () => [{ pid: 1 } as never] },
    // A Home that does not advertise v4 health: the bound legacy transport owns the observation.
    qualifiedConnectedAccountRuntime: { resolvePeerClass: () => 'exact_v0_2_1' } as unknown as QualifiedConnectedAccountRefreshRuntime,
    credentialHealthReprobeState,
    scheduledHealthProbeAtByKey,
    resolveBoundProfiles: () => bindings,
    resolveOperationTransport: () => ({ kind: 'legacy' }) as never,
    isOperationAvailable: () => true,
    maybeRefreshBinding,
    prepareScheduledQualifiedHealth: () => { throw new Error('no qualified profiles in this fixture'); },
  };
  let wakes = 0;
  while (clock - start < spanMs) {
    wakes += 1;
    const schedule = await runConnectedServiceRefreshTick(input as never);
    if (schedule.nextAutomaticRunAfterMs === null) break;
    clock += schedule.nextAutomaticRunAfterMs;
  }
  return { reads: maybeRefreshBinding.mock.calls.length, wakes };
}

describe('connected-service refresh tick idle cost', () => {
  it('observes each bound credential once, then reads nothing for 5 idle minutes before the expiry window', async () => {
    // 2 bound accounts expiring in 1 h: the refresh window opens at 50 min.
    const { reads, wakes } = await idleFor(5 * 60_000, 60 * 60_000);
    expect({ reads, wakes }).toEqual({ reads: 2, wakes: 1 });
  });

  it('fires the expiry deadline once per binding when the refresh window opens', async () => {
    const { reads, wakes } = await idleFor(60 * 60_000, 60 * 60_000);
    // Start observation + one refresh at expiry − window, per binding.
    expect({ reads, wakes }).toEqual({ reads: 4, wakes: 2 });
  });

  it('parks with no wake at all for credentials without an expiry', async () => {
    const { reads, wakes } = await idleFor(5 * 60_000, null);
    expect({ reads, wakes }).toEqual({ reads: 2, wakes: 1 });
  });
});
