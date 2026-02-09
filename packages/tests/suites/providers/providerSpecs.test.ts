import { describe, expect, it } from 'vitest';

import { loadCliProviderSpecs } from '../../src/testkit/providers/providerSpecs';

describe('providers: cli provider specs', () => {
  it('discovers core provider specs from apps/cli backends', async () => {
    const specs = await loadCliProviderSpecs();
    const ids = specs.map((s) => s.id).sort();

    expect(ids).toContain('claude');
    expect(ids).toContain('opencode');
    // Codex spec is expected to exist even if codex-acp is not installed.
    expect(ids).toContain('codex');
    expect(ids).toContain('kilo');
    expect(ids).toContain('gemini');
    expect(ids).toContain('qwen');
    expect(ids).toContain('kimi');
    expect(ids).toContain('auggie');

    for (const spec of specs) {
      expect(typeof spec.enableEnvVar).toBe('string');
      expect(spec.enableEnvVar).toMatch(/^HAPPIER_/);
      expect(['acp', 'codex', 'claude']).toContain(spec.protocol);
      expect(typeof spec.traceProvider).toBe('string');
      expect(spec.traceProvider.length).toBeGreaterThan(0);
      expect(typeof spec.cli?.subcommand).toBe('string');
      expect((spec.cli?.subcommand ?? '').trim().length).toBeGreaterThan(0);
      expect(spec.cli?.extraArgs === undefined || Array.isArray(spec.cli?.extraArgs)).toBe(true);
      expect(spec.cli?.env === undefined || typeof spec.cli?.env === 'object').toBe(true);
      expect(spec.requiredBinaries === undefined || Array.isArray(spec.requiredBinaries)).toBe(true);
    }
  });
});
