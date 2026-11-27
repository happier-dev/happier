import { describe, expect, it } from 'vitest';
import * as runtime from '@happier-dev/plugin-sdk/agents/runtime';

describe('public native Agent projections', () => {
  it('lets an Agent correlate native ids without changing their bytes', () => {
    expect(runtime.readNonBlankOpaqueIdentifier(' native/+id\n')).toBe(' native/+id\n');
    expect(runtime.readNonBlankOpaqueIdentifier(' \n')).toBeNull();
  });

  it('lets an Agent order native versions and decline unrecognized update versions', () => {
    expect(runtime.compareVersions('1.5.15', '1.5.15')).toBe(0);
    expect(runtime.isNewerVersion('1.5.14', '1.5.15')).toBe(true);
    expect(runtime.isNewerVersion('unknown', '1.5.15')).toBe(false);
  });

  it('lets an activity publisher detect a wake settling at the same deadline', () => {
    const pending = { pendingUntil: 123 };
    expect(runtime.sessionRuntimeScheduledWakesEqual(pending, { ...pending })).toBe(true);
    expect(runtime.sessionRuntimeScheduledWakesEqual(pending, { ...pending, outcome: 'stopped' })).toBe(false);
  });

  it('projects Action-owned approval names and parses the longest admitted MCP server', () => {
    const names = runtime.listHappierToolAutoApprovedNamesV1();
    expect(names).toContain('action_execute');
    expect(names).not.toContain('bash');
    expect(runtime.listHappierToolAutoApprovedNameSpellingsV1('mcp__native__'))
      .toEqual(names.map((name) => `mcp__native__${name}`));
    const servers = new Set(['docs', 'docs__private', 'happier']);
    expect(runtime.parseMcpToolWireNameV1('mcp__docs__private__read', servers))
      .toEqual({ server: 'docs__private', tool: 'read' });
    expect(runtime.parseMcpToolWireNameV1('mcp__happier__action_execute', servers)).toBeNull();
  });

  it('prices disjoint native token categories while retaining unknown accounting', () => {
    const tokens = { input: 100, output: 20, cacheRead: 20, cacheWrite: 10, reasoning: 5, total: 120 };
    expect(runtime.resolveUsageTokenCategories(tokens, null)).toBeNull();
    const categories = runtime.resolveUsageTokenCategories(tokens, {
      inputIncludesCache: true, outputIncludesReasoning: true,
    });
    expect(categories).toEqual({ ...tokens, input: 70, output: 15 });
    const estimate = runtime.estimateUsageModelCost('public-native-model', categories, undefined, {
      'public-native-model': {
        kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 10,
        cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 3,
      },
    });
    expect(estimate?.total).toBeCloseTo(0.00039, 10);
    expect(runtime.estimateUsageModelCost('unpriced-native-model', categories)).toBeNull();
  });

  it('keeps startup and goal failures closed and current native modes selectable', () => {
    expect(runtime.readAgentStartupFailureCode('agent_startup_transport_failed'))
      .toBe('agent_startup_transport_failed');
    expect(runtime.readAgentStartupFailureCode('native error with private data')).toBeNull();
    expect(runtime.AGENT_STARTUP_FAILURE_PREVIEWS.agent_startup_transport_failed).toBeTruthy();
    expect(runtime.SessionGoalControlFailureV1Schema.safeParse({ phase: 'tail_drain' }).success).toBe(true);
    expect(runtime.SessionGoalControlFailureV1Schema.safeParse({ phase: 'tail_drain', error: 'private' }).success).toBe(false);
    expect(runtime.isSessionModeSelectionUnavailable('retained', {
      currentModeId: 'retained', availableModes: [{ id: 'new' }],
    })).toBe(false);
    expect(runtime.isSessionModeSelectionUnavailable('missing', {
      currentModeId: 'retained', availableModes: [{ id: 'new' }],
    })).toBe(true);
  });
});
