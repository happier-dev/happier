import { describe, expect, it } from 'vitest';

import { resolveProviderRunPreset } from '../../src/testkit/providers/presets/presets';

describe('providers: run presets', () => {
  it('returns null for unknown preset or tier', () => {
    expect(resolveProviderRunPreset('nope', 'smoke')).toBeNull();
    expect(resolveProviderRunPreset('opencode', 'nope')).toBeNull();
  });

  it('enables expected provider env toggles per preset and tier', () => {
    const providerFlags = [
      'HAPPIER_E2E_PROVIDER_CLAUDE',
      'HAPPIER_E2E_PROVIDER_OPENCODE',
      'HAPPIER_E2E_PROVIDER_CODEX',
      'HAPPIER_E2E_PROVIDER_KILO',
      'HAPPIER_E2E_PROVIDER_GEMINI',
      'HAPPIER_E2E_PROVIDER_QWEN',
      'HAPPIER_E2E_PROVIDER_KIMI',
      'HAPPIER_E2E_PROVIDER_AUGGIE',
    ] as const;

    const cases: Array<{
      provider: Parameters<typeof resolveProviderRunPreset>[0];
      tier: Parameters<typeof resolveProviderRunPreset>[1];
      enabledFlags: readonly (typeof providerFlags)[number][];
    }> = [
      { provider: 'opencode', tier: 'smoke', enabledFlags: ['HAPPIER_E2E_PROVIDER_OPENCODE'] },
      { provider: 'claude', tier: 'extended', enabledFlags: ['HAPPIER_E2E_PROVIDER_CLAUDE'] },
      { provider: 'codex', tier: 'extended', enabledFlags: ['HAPPIER_E2E_PROVIDER_CODEX'] },
      { provider: 'kilo', tier: 'extended', enabledFlags: ['HAPPIER_E2E_PROVIDER_KILO'] },
      { provider: 'gemini', tier: 'extended', enabledFlags: ['HAPPIER_E2E_PROVIDER_GEMINI'] },
      { provider: 'qwen', tier: 'smoke', enabledFlags: ['HAPPIER_E2E_PROVIDER_QWEN'] },
      { provider: 'kimi', tier: 'extended', enabledFlags: ['HAPPIER_E2E_PROVIDER_KIMI'] },
      { provider: 'auggie', tier: 'smoke', enabledFlags: ['HAPPIER_E2E_PROVIDER_AUGGIE'] },
      {
        provider: 'all',
        tier: 'smoke',
        enabledFlags: [
          'HAPPIER_E2E_PROVIDER_CLAUDE',
          'HAPPIER_E2E_PROVIDER_OPENCODE',
          'HAPPIER_E2E_PROVIDER_CODEX',
          'HAPPIER_E2E_PROVIDER_KILO',
          'HAPPIER_E2E_PROVIDER_GEMINI',
          'HAPPIER_E2E_PROVIDER_QWEN',
          'HAPPIER_E2E_PROVIDER_KIMI',
          'HAPPIER_E2E_PROVIDER_AUGGIE',
        ],
      },
    ];

    for (const testCase of cases) {
      const preset = resolveProviderRunPreset(testCase.provider, testCase.tier);
      expect(preset).not.toBeNull();
      if (!preset) continue;
      expect(preset.env.HAPPIER_E2E_PROVIDERS).toBe('1');
      expect(preset.env.HAPPIER_E2E_PROVIDER_SCENARIO_TIER).toBe(testCase.tier);
      for (const flag of providerFlags) {
        if (testCase.enabledFlags.includes(flag)) {
          expect(preset.env[flag]).toBe('1');
        } else {
          expect(preset.env[flag]).toBeUndefined();
        }
      }
    }
  });
});
