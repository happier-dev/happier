import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function acpProvider(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: ['acp_in_flight_steer'], extended: ['acp_in_flight_steer'] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog: acp_in_flight_steer', () => {
  it('gates Codex step2 on primary Bash tool-call start', () => {
    const scenario = scenarioCatalog.acp_in_flight_steer(acpProvider('codex'));
    const step = scenario.steps?.[0];
    expect(step?.allowInFlightSteer).toBe(true);
    expect(step?.satisfaction?.requiredFixtureKeys).toContain('acp/codex/tool-call/Bash');
  });
});

