import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

const SCENARIO_ID = 'daemon_runner_continuity_a_to_b_to_c';

describe('scenarioCatalog: daemon runner continuity A to B to C', () => {
  it('registers one shared extended scenario for OpenCode, Pi, Claude, and Codex', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const selected = providers.filter((provider) => (
      provider.id === 'opencode'
      || provider.id === 'pi'
      || provider.id === 'claude'
      || provider.id === 'codex'
    ));

    expect(selected.map((provider) => provider.id).sort()).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);

    const factory = scenarioCatalog[SCENARIO_ID];
    expect(factory).toBeTypeOf('function');

    for (const provider of selected) {
      expect(provider.scenarioRegistry.tiers.extended).toContain(SCENARIO_ID);
      const scenario = factory!(provider);
      expect(scenario).toMatchObject({
        id: SCENARIO_ID,
        tier: 'extended',
        daemonRunnerContinuity: {
          phases: [
            { id: 'b' },
            { id: 'c' },
          ],
        },
      });
      expect(scenario.cliArgs).toBeUndefined();
    }
  });
});
