import { describe, expect, it, vi } from 'vitest';

describe('resolveCodexMcpServerSpawn', () => {
  it('returns codex CLI spawn', async () => {
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: 'codex' });
  });

  it('respects HAPPIER_CODEX_PATH override', async () => {
    const prev = process.env.HAPPIER_CODEX_PATH;
    process.env.HAPPIER_CODEX_PATH = '/tmp/custom-codex';
    try {
      vi.resetModules();
      const mod = await import('./resolveCodexMcpServerSpawn');
      await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: '/tmp/custom-codex' });
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_CODEX_PATH;
      else process.env.HAPPIER_CODEX_PATH = prev;
    }
  });
});
