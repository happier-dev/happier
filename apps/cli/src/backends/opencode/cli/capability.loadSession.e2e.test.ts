import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { cliCapability as openCodeCliCapability } from './capability';

function resolveBinaryOnPath(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8' }).trim();
    if (!out) return null;
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

describe('cli.opencode capability (ACP)', () => {
  const providersEnabled =
    (process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS) === '1'
    && (process.env.HAPPIER_E2E_PROVIDER_OPENCODE ?? process.env.HAPPY_E2E_PROVIDER_OPENCODE) === '1';

  it('returns deterministic capability results with or without provider probes enabled', async () => {
    const request = { id: 'cli.opencode', params: { includeAcpCapabilities: true } } as any;
    if (!providersEnabled) {
      const res = (await openCodeCliCapability.detect({
        request,
        context: {
          cliSnapshot: {
            path: process.env.PATH ?? null,
            clis: { opencode: { available: false } },
            tmux: { available: false },
          },
        } as any,
      })) as any;

      expect(res.available).toBe(false);
      expect(res.acp).toBeUndefined();
      return;
    }

    // This is a real binary probe. Keep it opt-in (mirrors provider harness gating).
    const resolvedPath = resolveBinaryOnPath('opencode');
    expect(resolvedPath, 'providers are enabled but opencode is not on PATH').not.toBeNull();

    const context = {
      cliSnapshot: {
        path: process.env.PATH ?? null,
        clis: {
          opencode: { available: true, resolvedPath: resolvedPath! },
        },
        tmux: { available: false },
      },
    } as any;

    const res = (await openCodeCliCapability.detect({ request, context })) as any;
    expect(res.available).toBe(true);
    expect(res.resolvedPath).toBe(resolvedPath);
    expect(res.acp?.ok).toBe(true);
    expect(res.acp?.loadSession).toBe(true);
  }, 60_000);
});
