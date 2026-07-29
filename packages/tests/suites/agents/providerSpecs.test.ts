import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadCliProviderSpecs,
  loadCliProviderSpecsFromRoot,
} from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: cli provider specs', () => {
  it('discovers core provider specs from plugin-owned provider directories', async () => {
    const specs = await loadCliProviderSpecs();
    const ids = specs.map((s) => s.id).sort();

    expect(ids).toContain('claude');
    expect(ids).toContain('opencode');
    expect(ids).toContain('kilo');
    expect(ids).toContain('kimi');
    expect(ids).toContain('auggie');
    expect(ids).toContain('pi');
    expect(ids).toContain('grok');
    expect(ids).toContain('claude_local');
    expect(ids).toContain('codex_acp_stub');
    expect(ids).toContain('opencode_server');

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

  it('does not discover retired apps/cli backend provider specs', async () => {
    const rootDir = join(tmpdir(), `happier-provider-specs-${process.pid}-${Date.now()}`);
    const pluginE2eDir = join(rootDir, 'packages', 'plugins', 'active_provider', 'src', 'agent', 'e2e');
    const retiredE2eDir = join(rootDir, 'apps', 'cli', 'src', 'backends', 'retired_provider', 'e2e');
    await mkdir(pluginE2eDir, { recursive: true });
    await mkdir(retiredE2eDir, { recursive: true });
    await writeFile(join(pluginE2eDir, 'providerSpec.json'), JSON.stringify({
      v: 1,
      id: 'active_provider',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_ACTIVE_PROVIDER',
      protocol: 'acp',
      traceProvider: 'active_provider',
      auth: { kind: 'none' },
      cli: { subcommand: 'active-provider' },
    }));
    await writeFile(join(retiredE2eDir, 'providerSpec.json'), JSON.stringify({
      v: 1,
      id: 'retired_provider',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_RETIRED_PROVIDER',
      protocol: 'acp',
      traceProvider: 'retired_provider',
      auth: { kind: 'none' },
      cli: { subcommand: 'retired-provider' },
    }));

    const ids = (await loadCliProviderSpecsFromRoot(rootDir)).map((spec) => spec.id);

    expect(ids).toContain('active_provider');
    expect(ids).not.toContain('retired_provider');
  });
});
