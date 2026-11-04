import { describe, expect, it } from 'vitest';
import { createLocalServerStormTracker, createRuntimeAuthRecoveryLocalServerGate } from './localServerStorm';
import { RuntimeAuthRecoveryScheduler } from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import axios, { AxiosError } from 'axios';

describe('local server storm', () => {
  it('counts real local HTTP failures and clears on local success, ignoring provider traffic and disposing its observer', async () => {
    const client = axios.create({ adapter: async (config) => {
      const response = { data: {}, headers: {}, config, status: config.url?.endsWith('fail') ? 503 : 200, statusText: '' };
      if (response.status === 503) throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, undefined, response);
      return response;
    } });
    const tracker = createLocalServerStormTracker({ nowMs: () => 1_000, windowMs: 60_000, serverUrl: 'http://local.test', client });
    try {
      for (let i = 0; i < 3; i++) await client.get('http://local.test/fail').catch(() => {});
      expect(tracker.failureCount()).toBe(3);
      await client.get('https://provider.test/success');
      expect(tracker.failureCount()).toBe(3);
      await client.get('http://local.test/success');
      expect(tracker.failureCount()).toBe(0);
      await client.get('https://provider.test/fail').catch(() => {});
      expect(tracker.failureCount()).toBe(0);
      tracker.dispose();
      await client.get('http://local.test/fail').catch(() => {});
      expect(tracker.failureCount()).toBe(0);
    } finally { tracker.dispose(); }
  });

  it('lets fifteen waiting intents drain the real failure window and resume quota work', async () => {
    let now = 1_000;
    const client = axios.create({ adapter: async (config) => {
      throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, undefined,
        { data: {}, headers: {}, config, status: 503, statusText: '' });
    } });
    const tracker = createLocalServerStormTracker({ nowMs: () => now, windowMs: 60_000, serverUrl: 'http://local.test', client });
    for (let i = 0; i < 3; i++) await client.get('http://local.test/fail').catch(() => {});
    const classification = { kind: 'usage_limit' as const, serviceId: 'openai-codex' as const,
      profileId: 'failed', groupId: 'pool', resetsAtMs: null, planType: null, rateLimits: null,
      source: 'structured_provider_error' as const };
    let recovered = 0;
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => now,
      recover: async () => { recovered++; return { status: 'no_eligible_member', groupExhausted: true }; },
      recordDiagnostic: (event) => tracker.recordRecoveryDiagnostic(event),
      gate: createRuntimeAuthRecoveryLocalServerGate({ nowMs: () => now, isShuttingDown: () => false,
        storm: tracker, threshold: 3, baseBackoffMs: 2_000, maxBackoffMs: 60_000, jitterMs: () => 0 }),
    });
    try {
      for (let i = 0; i < 15; i++) await scheduler.enqueueHandlerFailure({ sessionId: `session-${i}`, switchesThisTurn: 0,
        classification, error: { response: { status: 503 } } });
      for (now = 11_000; now <= 71_000; now += 10_000) {
        for (let i = 0; i < 15; i++) await scheduler.wake({ sessionId: `session-${i}`, reason: 'manual' });
      }
      expect(tracker.failureCount()).toBe(0);
      expect(recovered).toBeGreaterThan(0);
    } finally { scheduler.dispose(); tracker.dispose(); }
  });
});
