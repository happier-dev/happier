import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('seeds a workspace token and prompts execute_trace_ok with a real cat command', async () => {
    const scenario = scenarioCatalog.execute_trace_ok(opencodeServerProvider());
    expect(typeof scenario.setup).toBe('function');
    expect(typeof scenario.prompt).toBe('function');

    const workspaceDir = await mkdtemp(join(tmpdir(), 'opencode-server-execute-trace-ok-'));
    await scenario.setup?.({ workspaceDir, cliHome: workspaceDir });

    const tokenFile = join(workspaceDir, '.happier-execute-trace-ok-token.txt');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    expect(token.startsWith('TRACE_OK_')).toBe(true);

    const prompt = scenario.prompt?.({ workspaceDir }) ?? '';
    expect(prompt).toContain(`cat ${JSON.stringify(tokenFile)} && echo TRACE_OK`);
  });
});
