import { describe, expect, it, vi } from 'vitest';

import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

import { probeAntigravityCliPrintAvailability } from './availability.js';

describe('probeAntigravityCliPrintAvailability', () => {
  it('uses the slow-tolerant Antigravity CLI models readiness timeout', async () => {
    const resolve = vi.fn(async () => ({
      executable: { kind: 'systemTool' as const, id: 'antigravity-cli' },
      executablePath: '/usr/local/bin/agy',
    }));
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new TextEncoder().encode('Gemini 3.5 Flash (Medium)\n'),
      stderr: new TextEncoder().encode(''),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const exec = { systemTools: { resolve }, run } as unknown as PluginExecService;

    await expect(probeAntigravityCliPrintAvailability({
      exec,
      cwd: '/repo',
      cacheTtlMs: 0,
      now: () => 100,
    })).resolves.toEqual({ available: true });

    expect(resolve).toHaveBeenCalledWith({
      toolId: 'antigravity-cli',
      purpose: 'Check whether Antigravity CLI print model discovery is available.',
      cwd: '/repo',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'antigravity-cli' },
      args: ['models'],
      timeoutMs: 15_000,
    }), undefined);
  });
});
