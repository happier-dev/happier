import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function opencodeProvider(): ProviderUnderTest {
  return {
    id: 'opencode',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_OPENCODE',
    protocol: 'acp',
    traceProvider: 'opencode',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['task_subagent_reply'] } },
    cli: { subcommand: 'opencode' },
  };
}

describe('scenarioCatalog: opencode task_subagent_reply', () => {
  it('accepts provider-specific task aliases for call/result fixtures', () => {
    const scenario = scenarioCatalog.task_subagent_reply(opencodeProvider());
    expect(scenario.requiredAnyFixtureKeys).toEqual([
      ['acp/opencode/tool-call/Task', 'acp/opencode/tool-call/change_title'],
      ['acp/opencode/tool-result/Task', 'acp/opencode/tool-result/change_title'],
    ]);
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredTraceSubstrings).toBeUndefined();
    expect(scenario.postSatisfy?.waitForAcpSidechainFromToolName).toBe('Task');
  });
});
