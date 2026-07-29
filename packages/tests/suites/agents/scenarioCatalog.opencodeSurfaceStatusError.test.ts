import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function opencodeProvider(): ProviderUnderTest {
  return {
    id: 'opencode',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_OPENCODE',
    protocol: 'acp',
    traceProvider: 'opencode',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['opencode_surface_status_error'] } },
    cli: { subcommand: 'opencode' },
  };
}

describe('scenarioCatalog: opencode_surface_status_error', () => {
  it('builds a deterministic error-surfacing scenario for OpenCode', () => {
    const scenario = scenarioCatalog.opencode_surface_status_error(opencodeProvider());
    expect(scenario.id).toBe('opencode_surface_status_error');
    expect(scenario.tier).toBe('extended');
    expect(typeof scenario.prompt).toBe('function');
    expect(Array.isArray(scenario.requiredMessageSubstrings)).toBe(true);
    expect(scenario.requiredMessageSubstrings).toEqual(expect.arrayContaining(['Model not found']));
    const args = typeof scenario.cliArgs === 'function' ? scenario.cliArgs({ workspaceDir: '/tmp' }) : scenario.cliArgs;
    expect(args).toEqual(expect.arrayContaining(['--model', 'openai/does_not_exist']));
  });
});

