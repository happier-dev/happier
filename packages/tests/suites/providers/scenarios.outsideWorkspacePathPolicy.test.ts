import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeAcpPermissionOutsideWorkspaceScenario } from '../../src/testkit/providers/scenarios/scenarios.acp';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function claudeProviderStub(): ProviderUnderTest {
  return {
    id: 'claude',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_CLAUDE',
    protocol: 'claude',
    traceProvider: 'claude',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'claude' },
  };
}

describe('provider scenarios outside-workspace policy', () => {
  it('uses workspace-parent path policy for claude outside-workspace prompts', () => {
    const workspaceDir = '/tmp/workspace-root';
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const prompt = scenario.prompt({ workspaceDir });

    const match = prompt.match(/- Absolute path: (.+)/);
    expect(match).toBeTruthy();
    const outsidePath = match?.[1]?.trim() ?? '';

    expect(outsidePath.startsWith(workspaceDir)).toBe(false);
    expect(dirname(outsidePath)).toBe(dirname(workspaceDir));
  });

  it('initializes outside path in setup for ACP outside-workspace scenario', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'opencode',
      content: 'OUTSIDE_POLICY_TEST',
      decision: 'approve',
    });

    expect(typeof scenario.setup).toBe('function');
  });
});
