import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveTailscaleInstallPromptForExecutionContext', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('falls back to linux install guidance when remote platform detection is unavailable', async () => {
    const { resolveTailscaleInstallPromptForExecutionContext } = await import('./tailscaleExecutionContext.js');

    const prompt = await resolveTailscaleInstallPromptForExecutionContext({
      env: process.env,
      upstreamUrl: 'http://127.0.0.1:3005',
      runCommand: vi.fn(async () => {
        throw new Error('ssh shell unavailable');
      }),
    });

    expect(prompt.platform).toBe('linux');
    expect(prompt.url).toContain('/linux');
  });
});
