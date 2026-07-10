import { describe, expect, it, vi } from 'vitest';

import { probeAntigravityCliPrintAvailability } from './availability.js';

describe('probeAntigravityCliPrintAvailability', () => {
  it('uses the slow-tolerant Antigravity CLI models readiness timeout', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    await expect(probeAntigravityCliPrintAvailability({
      exec: { run },
      cwd: '/repo',
      cacheTtlMs: 0,
      now: () => 100,
    })).resolves.toEqual({ available: true });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: ['models'],
      cwd: '/repo',
    }), expect.objectContaining({
      timeoutMs: 15_000,
    }));
  });
});
