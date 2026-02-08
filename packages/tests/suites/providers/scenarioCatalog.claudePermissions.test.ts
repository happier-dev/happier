import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';
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

describe('scenarioCatalog (claude permissions)', () => {
  it('does not require permission-request fixtures for outside-workspace write surface scenario', () => {
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const keys = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(keys.some((key) => key.includes('/permission-request/'))).toBe(false);
    expect(keys.some((key) => key.includes('/tool-call/Write') || key.includes('/tool-call/Edit'))).toBe(true);
    expect(keys.some((key) => key.includes('/tool-result/Write') || key.includes('/tool-result/Edit'))).toBe(true);
  });

  it('pins allowed tools to Write/Edit for the outside-workspace scenario', () => {
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const messageMeta = scenario.messageMeta && typeof scenario.messageMeta === 'object'
      ? (scenario.messageMeta as Record<string, unknown>)
      : {};
    const allowedTools = Array.isArray(messageMeta.allowedTools) ? messageMeta.allowedTools : [];
    expect(allowedTools).toContain('Write');
    expect(allowedTools).toContain('Edit');
  });
});
