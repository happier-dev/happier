import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { cliCapability as openCodeCliCapability } from './capability';
import type { DetectCliEntry, DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';

type DetectArgs = Parameters<NonNullable<typeof openCodeCliCapability.detect>>[0];

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

function makeUnavailableCliEntry(): DetectCliEntry {
  return { available: false };
}

function makeCliSnapshot(overrides: Partial<DetectCliSnapshot['clis']>): DetectCliSnapshot {
  return {
    path: process.env.PATH ?? null,
    clis: {
      claude: makeUnavailableCliEntry(),
      codex: makeUnavailableCliEntry(),
      opencode: makeUnavailableCliEntry(),
      gemini: makeUnavailableCliEntry(),
      auggie: makeUnavailableCliEntry(),
      qwen: makeUnavailableCliEntry(),
      kimi: makeUnavailableCliEntry(),
      kilo: makeUnavailableCliEntry(),
      kiro: makeUnavailableCliEntry(),
      customAcp: makeUnavailableCliEntry(),
      pi: makeUnavailableCliEntry(),
      copilot: makeUnavailableCliEntry(),
      ...overrides,
    },
    tmux: { available: false },
    windowsTerminal: { available: false },
  };
}

describe('cli.opencode capability (ACP)', () => {
  const providersEnabled =
    (process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS) === '1'
    && (process.env.HAPPIER_E2E_PROVIDER_OPENCODE ?? process.env.HAPPY_E2E_PROVIDER_OPENCODE) === '1';

  it('returns deterministic capability results with or without provider probes enabled', async () => {
    const request: DetectArgs['request'] = { id: 'cli.opencode', params: { includeAcpCapabilities: true } };
    if (!providersEnabled) {
      const res = await openCodeCliCapability.detect({
        request,
        context: {
          cliSnapshot: makeCliSnapshot({ opencode: { available: false } }),
        },
      }) as {
        available: boolean;
        acp?: { ok: boolean; loadSession?: boolean };
      };

      expect(res.available).toBe(false);
      expect(res.acp).toBeUndefined();
      return;
    }

    // This is a real binary probe. Keep it opt-in (mirrors provider harness gating).
    const resolvedPath = resolveBinaryOnPath('opencode');
    expect(resolvedPath, 'providers are enabled but opencode is not on PATH').not.toBeNull();

    const context: DetectArgs['context'] = {
      cliSnapshot: {
        ...makeCliSnapshot({ opencode: { available: true, resolvedPath: resolvedPath! } }),
      },
    };

    const res = await openCodeCliCapability.detect({ request, context }) as {
      available: boolean;
      resolvedPath: string | null;
      acp?: { ok: boolean; loadSession?: boolean };
    };
    expect(res.available).toBe(true);
    expect(res.resolvedPath).toBe(resolvedPath);
    expect(res.acp?.ok).toBe(true);
    expect(res.acp?.loadSession).toBe(true);
  }, 60_000);
});
