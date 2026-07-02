import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { resolveGeminiAcpFlag } from './resolution.js';

function createContext(stdout: string): PluginContextV1 {
  return {
    exec: {
      run: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
      })),
    },
  } as unknown as PluginContextV1;
}

describe('resolveGeminiAcpFlag', () => {
  it('probes Gemini ACP flags through the host-mediated agent CLI launch', async () => {
    const ctx = createContext('Usage: gemini --acp');

    await expect(resolveGeminiAcpFlag(ctx, { env: { GEMINI_CLI_HOME: '/tmp/gemini' } })).resolves.toBe('--acp');

    expect(ctx.exec.run).toHaveBeenCalledWith(
      {
        kind: 'agent-cli',
        agentId: 'gemini',
        args: ['--help'],
        env: { GEMINI_CLI_HOME: '/tmp/gemini' },
      },
      { timeoutMs: 2000 },
    );
  });

  it('does not convert host-aborted probes into the default flag', async () => {
    const abortError = new Error('Plugin exec operation was aborted');
    abortError.name = 'AbortError';
    const ctx = {
      exec: {
        run: vi.fn(async () => {
          throw abortError;
        }),
      },
    } as unknown as PluginContextV1;

    await expect(resolveGeminiAcpFlag(ctx, {})).rejects.toBe(abortError);
  });
});
