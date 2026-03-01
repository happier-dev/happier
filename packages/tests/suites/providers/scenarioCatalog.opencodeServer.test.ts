import { describe, expect, it } from 'vitest';

import type { ProviderUnderTest } from '../../src/testkit/providers/types';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

function opencodeServerProvider(): ProviderUnderTest {
  return {
    id: 'opencode_server',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_OPENCODE_SERVER',
    protocol: 'acp',
    // Keep trace provider aligned with OpenCode so existing fixtures and schemas apply.
    traceProvider: 'opencode',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'opencode' },
  };
}

describe('scenarioCatalog (opencode_server)', () => {
  it('treats opencode_server as OpenCode-family for execute_trace_ok', () => {
    const scenario = scenarioCatalog.execute_trace_ok(opencodeServerProvider());
    expect(scenario.id).toBe('execute_trace_ok');
    expect(scenario.requiredFixtureKeys).toEqual(['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash']);
  });

  it('treats opencode_server as OpenCode-family for search_known_token normalization checks', () => {
    const scenario = scenarioCatalog.search_known_token(opencodeServerProvider());
    expect(scenario.id).toBe('search_known_token');
    expect(typeof scenario.verify).toBe('function');
  });

  it('supports task_subagent_reply scenarios for opencode_server', () => {
    const scenario = scenarioCatalog.task_subagent_reply(opencodeServerProvider() as any);
    expect(scenario.id).toBe('task_subagent_reply');
    expect(scenario.postSatisfy?.waitForAcpSidechainFromToolName).toBe('Task');
  });
});
