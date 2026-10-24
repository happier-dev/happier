import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS',
]);

async function loadIdleExitMs(value: string | undefined): Promise<number> {
  if (value === undefined) delete process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS;
  else process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS = value;
  vi.resetModules();
  const { configuration } = await import('./configuration');
  return configuration.claudeRemoteIdleExitMs;
}

describe('configuration claudeRemoteIdleExitMs', () => {
  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('defaults to 30 minutes and lets 0 disable idle exit', async () => {
    expect(await loadIdleExitMs(undefined)).toBe(30 * 60_000);
    expect(await loadIdleExitMs('0')).toBe(0);
  });

  it('caps oversized values at the longest delay a timer can wait instead of overflowing to an immediate exit', async () => {
    // setTimeout treats delays above 2^31-1 ms as 1 ms, which would stop every idle child at once.
    expect(await loadIdleExitMs('99999999999')).toBe(2 ** 31 - 1);
  });
});
