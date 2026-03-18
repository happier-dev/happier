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
  it('uses Task fixtures for call/result transcripts', () => {
    const scenario = scenarioCatalog.task_subagent_reply(opencodeProvider());
    expect(scenario.requiredFixtureKeys).toEqual(['acp/opencode/tool-call/Task', 'acp/opencode/tool-result/Task']);
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(scenario.requiredTraceSubstrings).toBeUndefined();
    expect(scenario.postSatisfy?.waitForAcpSidechainFromToolName).toBe('Task');
  });
});
