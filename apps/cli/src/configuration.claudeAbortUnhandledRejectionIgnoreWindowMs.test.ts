import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS',
]);

describe('configuration claudeAbortUnhandledRejectionIgnoreWindowMs', () => {
  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('defaults to 10s when env var is unset or invalid', async () => {
    delete process.env.HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS;
    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.claudeAbortUnhandledRejectionIgnoreWindowMs).toBe(10_000);

    process.env.HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS = '-1';
    vi.resetModules();
    const { configuration: configuration2 } = await import('./configuration');
    expect(configuration2.claudeAbortUnhandledRejectionIgnoreWindowMs).toBe(10_000);
  });

  it('allows disabling suppression by setting 0', async () => {
    process.env.HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS = '0';
    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.claudeAbortUnhandledRejectionIgnoreWindowMs).toBe(0);
  });

  it('clamps the ignore window to 60s', async () => {
    process.env.HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS = '60001';
    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.claudeAbortUnhandledRejectionIgnoreWindowMs).toBe(60_000);
  });
});
