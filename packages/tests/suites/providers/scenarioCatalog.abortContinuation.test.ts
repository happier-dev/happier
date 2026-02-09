import { describe, expect, it } from 'vitest';

import { abortContinuationFollowupSubstrings, scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function providerStub(id: ProviderUnderTest['id'], protocol: ProviderUnderTest['protocol'], subcommand: string): ProviderUnderTest {
  return {
    id,
    protocol,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${String(id).toUpperCase()}`,
    traceProvider: protocol === 'acp' ? String(id) : 'claude',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand },
  };
}

describe('scenarioCatalog: abort continuation contract', () => {
  it('maps ACP follow-up assertions by provider reliability profile', () => {
    expect(abortContinuationFollowupSubstrings('auggie', 'FOLLOWUP', 'MEMORY')).toEqual(['FOLLOWUP']);
    expect(abortContinuationFollowupSubstrings('kimi', 'FOLLOWUP', 'MEMORY')).toEqual(['FOLLOWUP']);
    expect(abortContinuationFollowupSubstrings('opencode', 'FOLLOWUP', 'MEMORY')).toEqual(['FOLLOWUP', 'MEMORY']);
  });

  it('builds a claude abort-continue scenario with post-satisfaction runner', () => {
    const scenario = scenarioCatalog.abort_turn_then_continue(providerStub('claude', 'claude', 'claude'));
    expect(scenario.id).toBe('abort_turn_then_continue');
    expect(scenario.tier).toBe('extended');
    expect(scenario.yolo).toBe(true);
    expect(scenario.requiredFixtureKeys).toEqual([]);
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
    expect(typeof scenario.verify).toBe('function');
  });

  it('builds an ACP abort-continue scenario with yolo auto-approve enabled', () => {
    const scenario = scenarioCatalog.abort_turn_then_continue(providerStub('opencode', 'acp', 'opencode'));
    expect(scenario.requiredFixtureKeys).toEqual([]);
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });

  it('builds ACP abort-continue scenarios for qwen and auggie', () => {
    const qwen = scenarioCatalog.abort_turn_then_continue(providerStub('qwen', 'acp', 'qwen'));
    const auggie = scenarioCatalog.abort_turn_then_continue(providerStub('auggie', 'acp', 'auggie'));

    expect(qwen.id).toBe('abort_turn_then_continue');
    expect(auggie.id).toBe('abort_turn_then_continue');
    expect(typeof qwen.postSatisfy?.run).toBe('function');
    expect(typeof auggie.postSatisfy?.run).toBe('function');
  });

  it('uses a semantic continuation prompt contract after abort', () => {
    const kimi = scenarioCatalog.abort_turn_then_continue(providerStub('kimi', 'acp', 'kimi'));
    const prompt = kimi.prompt?.({ workspaceDir: '/tmp/workspace' } as any) ?? '';
    expect(prompt).toContain('ABORT_READY_');
    expect(prompt).not.toContain('sleep 20');
  });
});
