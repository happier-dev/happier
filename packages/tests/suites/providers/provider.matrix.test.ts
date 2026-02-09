import { describe, expect, it } from 'vitest';

import { runProviderContractMatrix } from '../../src/testkit/providers/harness';

describe('providers: contract matrix (harness)', () => {
  const providerEnvVars = [
    // Extended provider matrix runs can exceed 20 minutes under parallel load for large ACP suites.
    // Keep timeouts realistic so we fail on real regressions, not harness wall-clock limits.
    { id: 'opencode', envVar: 'HAPPIER_E2E_PROVIDER_OPENCODE', timeoutMs: 2_400_000 },
    { id: 'claude', envVar: 'HAPPIER_E2E_PROVIDER_CLAUDE', timeoutMs: 1_800_000 },
    // Codex extended runs include many ACP scenarios and can legitimately exceed 40 minutes on
    // loaded developer machines; keep this higher to avoid false timeout failures.
    { id: 'codex', envVar: 'HAPPIER_E2E_PROVIDER_CODEX', timeoutMs: 4_800_000 },
    { id: 'kilo', envVar: 'HAPPIER_E2E_PROVIDER_KILO', timeoutMs: 2_400_000 },
    { id: 'gemini', envVar: 'HAPPIER_E2E_PROVIDER_GEMINI', timeoutMs: 2_400_000 },
    { id: 'qwen', envVar: 'HAPPIER_E2E_PROVIDER_QWEN', timeoutMs: 1_200_000 },
    { id: 'kimi', envVar: 'HAPPIER_E2E_PROVIDER_KIMI', timeoutMs: 1_200_000 },
    { id: 'auggie', envVar: 'HAPPIER_E2E_PROVIDER_AUGGIE', timeoutMs: 1_200_000 },
  ] as const;

  const providersEnabled = (process.env.HAPPIER_E2E_PROVIDERS ?? '').toString().trim() === '1';
  const disabledTimeoutMs = Math.max(...providerEnvVars.map((p) => p.timeoutMs));

  async function runMatrixWithOnlyProvider(providerEnvVar: string) {
    const saved: Record<string, string | undefined> = {};
    for (const { envVar } of providerEnvVars) saved[envVar] = process.env[envVar];

    try {
      for (const { envVar } of providerEnvVars) {
        process.env[envVar] = envVar === providerEnvVar ? '1' : '0';
      }
      return await runProviderContractMatrix();
    } finally {
      for (const { envVar } of providerEnvVars) {
        const value = saved[envVar];
        if (typeof value === 'string') process.env[envVar] = value;
        else delete process.env[envVar];
      }
    }
  }

  it.skipIf(providersEnabled)(
    'runs provider scenario matrix (providers disabled)',
    async () => {
      const res = await runProviderContractMatrix();
      if (!res.ok) throw new Error(res.error);
      expect(res.ok).toBe(true);
    },
    disabledTimeoutMs,
  );

  for (const { id, envVar, timeoutMs } of providerEnvVars) {
    const providerEnabled = (process.env[envVar] ?? '').toString().trim() === '1';

    it.skipIf(!providersEnabled || !providerEnabled)(
      `runs provider scenario matrix for ${id} when enabled`,
      async () => {
        const res = await runMatrixWithOnlyProvider(envVar);
        if (!res.ok) {
          throw new Error(res.error);
        }
        expect(res.ok).toBe(true);
      },
      timeoutMs,
    );
  }
});
