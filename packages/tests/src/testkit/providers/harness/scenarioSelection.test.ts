import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProviderProtocol, ProviderUnderTest } from '../types';
import { resolveScenarioById } from './scenarioSelection';

function provider(id: ProviderUnderTest['id'], protocol: ProviderProtocol): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_${String(id).toUpperCase()}`,
    protocol,
    traceProvider: String(id),
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: String(id) },
  };
}

describe('daemon runner continuity scenario selection', () => {
  it('selects the active-turn continuity lifecycle and existing vendor identity keys', async () => {
    const expectedMetadataKeys = new Map<ProviderUnderTest['id'], string>([
      ['opencode', 'opencodeSessionId'],
      ['pi', 'piSessionId'],
      ['claude', 'claudeSessionId'],
      ['codex', 'codexSessionId'],
    ]);
    const protocols = new Map<ProviderUnderTest['id'], ProviderProtocol>([
      ['opencode', 'acp'],
      ['pi', 'acp'],
      ['claude', 'claude'],
      ['codex', 'codex'],
    ]);

    for (const [providerId, metadataKey] of expectedMetadataKeys) {
      const scenario = resolveScenarioById({
        provider: provider(providerId, protocols.get(providerId) ?? 'acp'),
        id: 'daemon_runner_continuity_a_to_b_to_c',
        expectedTier: 'extended',
      });
      expect(scenario.daemonRunnerContinuity?.identityEvidence?.vendorSessionMetadataKey).toBe(metadataKey);
      expect(typeof scenario.daemonRunnerContinuity?.identityEvidence?.observeAgentChildProcess)
        .toBe(providerId === 'codex' ? 'function' : 'undefined');
      expect(scenario.daemonRunnerContinuity?.phases.map((phase) => phase.id)).toEqual(['b', 'c']);
      expect(scenario.daemonRunnerContinuity?.retainedPluginLifecycle).toBeUndefined();
    }

    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-continuity-scenario-'));
    try {
      const scenario = resolveScenarioById({
        provider: provider('opencode', 'acp'),
        id: 'daemon_runner_continuity_a_to_b_to_c',
      });
      await scenario.setup?.({ workspaceDir, cliHome: join(workspaceDir, '.home') });
      const continuity = scenario.daemonRunnerContinuity;
      expect(continuity).toBeDefined();
      if (!continuity) throw new Error('Missing daemon continuity configuration');
      const [phaseB, phaseC] = continuity.phases;
      const effectB = phaseB.effect({ workspaceDir });
      const effectC = phaseC.effect({ workspaceDir });
      expect(await readFile(effectB.path, 'utf8')).toBe('');
      expect(await readFile(effectC.path, 'utf8')).toBe('');

      const names = await readdir(workspaceDir);
      const scriptB = names.find((name) => name.includes('continuity-b.') && !name.endsWith('.effects'));
      const scriptC = names.find((name) => name.includes('continuity-c.') && !name.endsWith('.effects'));
      expect(scriptB).toBeDefined();
      expect(scriptC).toBeDefined();
      if (!scriptB || !scriptC) throw new Error('Missing continuity effect script');
      const contentsB = await readFile(join(workspaceDir, scriptB), 'utf8');
      const contentsC = await readFile(join(workspaceDir, scriptC), 'utf8');
      expect(contentsB).toContain(effectB.marker);
      expect(contentsC).toContain(effectC.marker);
      expect(contentsB).toContain(process.platform === 'win32' ? 'ping -n 21' : 'sleep 20');
      expect(contentsC).not.toContain(process.platform === 'win32' ? 'ping -n ' : 'sleep ');
      expect(phaseB.prompt({ workspaceDir })).toContain(scriptB);
      expect(phaseC.prompt({ workspaceDir })).toContain(scriptC);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
