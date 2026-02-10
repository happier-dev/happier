import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function kiloProvider(): ProviderUnderTest {
  return {
    id: 'kilo',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_KILO',
    protocol: 'acp',
    traceProvider: 'kilo',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['kilo_task_subagent_reply'] } },
    cli: { subcommand: 'kilo' },
  };
}

describe('scenarioCatalog: kilo_task_subagent_reply', () => {
  it('accepts provider-specific task aliases for call/result fixtures', () => {
    const scenario = scenarioCatalog.kilo_task_subagent_reply(kiloProvider());
    expect(scenario.requiredAnyFixtureKeys).toEqual([
      ['acp/kilo/tool-call/Task', 'acp/kilo/tool-call/change_title'],
      ['acp/kilo/tool-result/Task', 'acp/kilo/tool-result/change_title'],
    ]);
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.postSatisfy).toBeUndefined();
  });
});
