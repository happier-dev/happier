import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runProviderContractMatrix } from '../../src/testkit/providers/harness';

type LedgerEntry = {
  providerId: string;
  source: string;
  tokens: Record<string, number>;
};

describe('providers harness: token telemetry (acp stub provider)', () => {
  const providersEnabled = (process.env.HAPPIER_E2E_PROVIDERS ?? '').toString().trim() === '1';

  it.skipIf(!providersEnabled)(
    'captures token telemetry entries with tokens for an ACP provider',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'happier-providers-token-ledger-'));
      const ledgerPath = join(tempDir, 'provider-token-ledger.v1.json');
      await rm(ledgerPath, { force: true }).catch(() => undefined);

      const envVars = [
        'HAPPIER_E2E_PROVIDER_CODEX_ACP_STUB',
        'HAPPIER_E2E_PROVIDER_OPENCODE',
        'HAPPIER_E2E_PROVIDER_CLAUDE',
        'HAPPIER_E2E_PROVIDER_CODEX',
        'HAPPIER_E2E_PROVIDER_KILO',
        'HAPPIER_E2E_PROVIDER_GEMINI',
        'HAPPIER_E2E_PROVIDER_QWEN',
        'HAPPIER_E2E_PROVIDER_KIMI',
        'HAPPIER_E2E_PROVIDER_AUGGIE',
        'HAPPIER_E2E_PROVIDER_SCENARIOS',
        'HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH',
      ] as const;

      const saved: Record<string, string | undefined> = {};
      for (const key of envVars) saved[key] = process.env[key];

      try {
        process.env.HAPPIER_E2E_PROVIDER_CODEX_ACP_STUB = '1';
        process.env.HAPPIER_E2E_PROVIDER_OPENCODE = '0';
        process.env.HAPPIER_E2E_PROVIDER_CLAUDE = '0';
        process.env.HAPPIER_E2E_PROVIDER_CODEX = '0';
        process.env.HAPPIER_E2E_PROVIDER_KILO = '0';
        process.env.HAPPIER_E2E_PROVIDER_GEMINI = '0';
        process.env.HAPPIER_E2E_PROVIDER_QWEN = '0';
        process.env.HAPPIER_E2E_PROVIDER_KIMI = '0';
        process.env.HAPPIER_E2E_PROVIDER_AUGGIE = '0';
        process.env.HAPPIER_E2E_PROVIDER_SCENARIOS = 'acp_stub_usage_update';
        process.env.HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH = ledgerPath;

        const res = await runProviderContractMatrix();
        if (!res.ok) throw new Error(res.error);
        expect(res.ok).toBe(true);

        expect(existsSync(ledgerPath)).toBe(true);
        const raw = await readFile(ledgerPath, 'utf8');
        const parsed = JSON.parse(raw) as { entries?: unknown };
        const entries = Array.isArray(parsed.entries) ? (parsed.entries as LedgerEntry[]) : [];

        const stubEntries = entries.filter((entry) => entry.providerId === 'codex_acp_stub');
        expect(stubEntries.length).toBeGreaterThan(0);

        const withTokens = stubEntries.filter((entry) => (entry.tokens?.total ?? 0) > 0);
        expect(withTokens.length).toBeGreaterThan(0);
      } finally {
        for (const key of envVars) {
          const value = saved[key];
          if (typeof value === 'string') process.env[key] = value;
          else delete process.env[key];
        }
      }
    },
    900_000,
  );
});
