import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { cliCapability as codexCliCapability } from './capability';
import { resolveCodexAcpSpawn } from '@/backends/codex/acp/resolveCommand';

type DetectArgs = Parameters<NonNullable<typeof codexCliCapability.detect>>[0];

function resolveBinaryOnPath(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8' }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

function resolveCodexAcpIfAvailable(): string | null {
  try {
    const spawn = resolveCodexAcpSpawn();
    if (spawn.command.includes('/') || spawn.command.includes('\\')) {
      return existsSync(spawn.command) ? spawn.command : null;
    }
    return resolveBinaryOnPath(spawn.command);
  } catch {
    return null;
  }
}

function resolveProbeGate(): { enabled: boolean; reason: string } {
  const providersGate = process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS;
  const codexGate = process.env.HAPPIER_E2E_PROVIDER_CODEX ?? process.env.HAPPY_E2E_PROVIDER_CODEX;
  if (providersGate !== '1' || codexGate !== '1') {
    return {
      enabled: false,
      reason: 'requires HAPPIER_E2E_PROVIDERS=1 and HAPPIER_E2E_PROVIDER_CODEX=1',
    };
  }

  const resolvedCodexPath = resolveBinaryOnPath('codex');
  if (!resolvedCodexPath) {
    return { enabled: false, reason: 'requires codex binary on PATH' };
  }

  const resolvedAcpPath = resolveCodexAcpIfAvailable();
  if (!resolvedAcpPath) {
    return { enabled: false, reason: 'requires codex-acp binary (or npx fallback)' };
  }

  return { enabled: true, reason: 'probe requirements satisfied' };
}

function makeUnavailableCliEntry() {
  return { available: false, resolvedPath: undefined };
}

describe('cli.codex capability (ACP)', () => {
  const gate = resolveProbeGate();
  const probeIt = gate.enabled ? it : it.skip;

  probeIt(`detects session/load support when codex ACP is available [${gate.reason}]`, async () => {
    const originalAcpBin = process.env.HAPPIER_CODEX_ACP_BIN;
    const originalNpxMode = process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    // This is a real binary probe. Keep it opt-in (mirrors provider harness gating).
    try {
      const envAcpBinRaw = process.env.HAPPIER_E2E_PROVIDER_CODEX_ACP_BIN ?? process.env.HAPPY_E2E_PROVIDER_CODEX_ACP_BIN;
      const envAcpBin = typeof envAcpBinRaw === 'string'
        ? envAcpBinRaw.trim()
        : '';
      if (envAcpBin) {
        process.env.HAPPIER_CODEX_ACP_BIN = envAcpBin;
      }
      // Provider tests run in ephemeral environments where `codex-acp` is not installed.
      // Prefer the documented `npx -y @zed-industries/codex-acp` path when probing.
      process.env.HAPPIER_CODEX_ACP_NPX_MODE = 'force';

      const resolvedCodexPath = resolveBinaryOnPath('codex');
      expect(resolvedCodexPath).toBeTruthy();

      const resolvedAcpPath = resolveCodexAcpIfAvailable();
      expect(resolvedAcpPath).toBeTruthy();

      const request: DetectArgs['request'] = { id: 'cli.codex', params: { includeAcpCapabilities: true } };
      const context: DetectArgs['context'] = {
        cliSnapshot: {
          path: process.env.PATH ?? null,
          clis: {
            claude: makeUnavailableCliEntry(),
            codex: { available: true, resolvedPath: resolvedCodexPath as string },
            opencode: makeUnavailableCliEntry(),
            gemini: makeUnavailableCliEntry(),
            auggie: makeUnavailableCliEntry(),
            qwen: makeUnavailableCliEntry(),
            kimi: makeUnavailableCliEntry(),
            kilo: makeUnavailableCliEntry(),
            pi: makeUnavailableCliEntry(),
            copilot: makeUnavailableCliEntry(),
          },
          tmux: { available: false },
        },
      };

      const rawResult = await codexCliCapability.detect({ request, context });
      const res = rawResult as {
        available: boolean;
        resolvedPath: string | null;
        acp?: { ok: boolean; loadSession?: boolean };
      };
      expect(res.available).toBe(true);
      expect(res.resolvedPath).toBe(resolvedCodexPath);
      expect(res.acp).toMatchObject({ ok: true, loadSession: true });
    } finally {
      if (originalAcpBin === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env.HAPPIER_CODEX_ACP_BIN;
      } else {
        process.env.HAPPIER_CODEX_ACP_BIN = originalAcpBin;
      }
      if (originalNpxMode === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;
      } else {
        process.env.HAPPIER_CODEX_ACP_NPX_MODE = originalNpxMode;
      }
    }
  }, 60_000);
});
