import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as yieldToFilesystem } from 'node:timers/promises';
import { createConnectedServicePoolRecoveryFixture, POOL_RECOVERY_START_MS } from './testkit/connectedServicePoolRecovery.testkit';

describe('composed connected-service pool recovery (synthetic boundaries)', () => {
  const fixtures: Awaited<ReturnType<typeof createConnectedServicePoolRecoveryFixture>>[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(POOL_RECOVERY_START_MS); });
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
    vi.unstubAllGlobals(); vi.useRealTimers();
  });
  async function setup(input: Parameters<typeof createConnectedServicePoolRecoveryFixture>[0] = {}) {
    const fixture = await createConnectedServicePoolRecoveryFixture(input);
    fixtures.push(fixture);
    return fixture;
  }
  async function failWithClock(fixture: Awaited<ReturnType<typeof setup>>) {
    let completed = false;
    const failure = fixture.fail().finally(() => { completed = true; });
    // waitFor advances fake timers after asynchronous durable-store writes have settled.
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000, interval: 20 });
    return await failure;
  }
  async function advanceClock(milliseconds: number) {
    // Real durable-store I/O must finish between ticks; one large fake-clock jump
    // would expire the file lock while its asynchronous acquisition is running.
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(Math.min(100, milliseconds - elapsed));
      await yieldToFilesystem(1);
    }
  }
  function expectContinued(fixture: Awaited<ReturnType<typeof setup>>) {
    expect(fixture.providerRequests.length, JSON.stringify({ results: fixture.results,
      intents: fixture.scheduler().hydratePassive().map(({ status, nextRetryAtMs, attemptCount, lastError }) => ({ status, nextRetryAtMs, attemptCount, lastError })),
    })).toBeGreaterThan(0);
    for (const session of fixture.sessions) {
      const id = session.happySessionId!;
      expect(fixture.applied.get(id), JSON.stringify({ sessionId: id, results: fixture.results,
        intents: fixture.scheduler().hydratePassive(), diagnostics: fixture.diagnostics })).not.toBe(fixture.failedProfile);
      expect(fixture.applied.get(id), `selected account for ${id}`).toBe('B');
      expect(fixture.applied.get(id)).toBe(fixture.group().activeProfileId);
      expect(fixture.registry.getBySessionId(id)?.activeBindings[0]?.profileId).toBe(fixture.group().activeProfileId);
      expect(fixture.prompts.filter(prompt => prompt.sessionId === id).map(prompt => prompt.message), `continuation for ${id}`)
        .toContain('Usage limits are lifted. Continue where you left off.');
    }
    expect(fixture.diagnostics.filter(event => event.event === 'runtime_auth_recovery_dead_letter')).toEqual([]);
  }
  async function expectSettledAfterProviderOutput(fixture: Awaited<ReturnType<typeof setup>>) {
    const settled = await fixture.proveProviderActivity();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('recovered');
    const promptCount = fixture.prompts.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fixture.prompts).toHaveLength(promptCount);
    expect(fixture.scheduler().hydratePassive().every(intent => intent.status === 'recovered')).toBe(true);
    expect(fixture.diagnostics.filter(event => event.event === 'runtime_auth_recovery_dead_letter')).toEqual([]);
  }

  it.each(['five_hour', 'seven_day'] as const)('switches twelve sessions and sends usage continuation after %s exhaustion', async window => {
    const fixture = await setup({ window });
    await fixture.fail();
    await vi.advanceTimersByTimeAsync(5_000);
    expectContinued(fixture);
    await expectSettledAfterProviderOutput(fixture);
  });

  it('recovers twelve sessions after a sixty-second Happier 503 burst', async () => {
    const fixture = await setup({ serverOutageMs: 60_000 });
    // Initial load retries sleep on the injected clock while the server is unavailable.
    await failWithClock(fixture);
    expect(fixture.prompts).toEqual([]);
    await advanceClock(120_000);
    await vi.waitFor(() => expectContinued(fixture), { timeout: 5_000, interval: 20 });
    expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ reason: 'local_server_storm' }));
    expect(fixture.scheduler().hydratePassive()[0]?.attemptCount).toBeLessThan(5);
    await expectSettledAfterProviderOutput(fixture);
  });

  it('attributes a shared-home failure to A-prime despite stale A spawn metadata', async () => {
    const fixture = await setup({ drift: true });
    await fixture.fail();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.group().members.find(member => member.profileId === 'A-prime')?.state.quotaExhaustedUntilMs)
      .toBeGreaterThan(POOL_RECOVERY_START_MS);
    expect(fixture.group().members.find(member => member.profileId === 'A')?.state.quotaExhaustedUntilMs).toBeUndefined();
    expectContinued(fixture);
    await expectSettledAfterProviderOutput(fixture);
  });

  it('rehydrates durable recovery after daemon-owner replacement during the server outage', async () => {
    const fixture = await setup({ serverOutageMs: 60_000 });
    await failWithClock(fixture);
    const restored = await fixture.restart();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.classification.profileId).toBe('A');
    await advanceClock(120_000);
    await vi.waitFor(() => expectContinued(fixture), { timeout: 5_000, interval: 20 });
    expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ reason: 'local_server_storm' }));
    expect(fixture.scheduler().hydratePassive()[0]?.attemptCount).toBeLessThan(5);
    await expectSettledAfterProviderOutput(fixture);
  });

  it('selects a replacement on scheduler retry when the hard-limit quota probe is unavailable', async () => {
    const fixture = await setup({ quotaProbeUnavailable: true });
    await fixture.fail();
    expect(fixture.group().activeProfileId).toBe('B');
    expect(fixture.applied.get(fixture.sessions[0]!.happySessionId!)).toBe('B');
  });

  it('visibly waits for the earliest exhausted-member reset then continues all sessions', async () => {
    const fixture = await setup({ allExhausted: true });
    await fixture.fail();
    const waiting = fixture.scheduler().hydratePassive()[0];
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.nextRetryAtMs).toBe(fixture.resetAt);
    const visible: unknown[] = [];
    await fixture.scheduler().drainPendingVisibleEvents(async delivery => { visible.push(delivery.transcriptEvent); });
    expect(visible.length, 'waiting must have a deliverable user-visible status').toBeGreaterThan(0);
    expect(fixture.prompts).toEqual([]);
    await advanceClock(125_000);
    await vi.waitFor(() => expectContinued(fixture), { timeout: 5_000, interval: 20 });
    await expectSettledAfterProviderOutput(fixture);
  });
});
