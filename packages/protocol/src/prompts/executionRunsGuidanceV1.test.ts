import { describe, expect, it } from 'vitest';

import { buildExecutionRunsGuidanceBlockV1, normalizeExecutionRunsGuidanceFingerprintV1 } from './executionRunsGuidanceV1.js';

describe('executionRunsGuidanceV1', () => {
  it('always emits the fixed native-first guidance independently of custom rules', () => {
    const result = buildExecutionRunsGuidanceBlockV1({ entries: [], maxChars: 0 });

    expect(result.text).toContain("current backend's native subagent facility by default");
    expect(result.text).toContain('Happier subagent');
    expect(result.text).toContain('Happier delegation run');
    expect(result.text).toContain('Happier execution run');
    expect(result.text).toContain('omit `sessionId`');
    expect(result.text).toContain('intentional explicit cross-session target');
    expect(result.text.toLowerCase()).not.toContain('custom rule');
    expect(result.text).not.toContain('another host');
  });

  it('keeps the fixed guidance when the custom-rule budget is too small', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [{ id: '1', description: 'Use a Happier review run' }],
      maxChars: 1,
    });

    expect(result.text).toContain("current backend's native subagent facility by default");
    expect(result.text).not.toContain('Use a Happier review run');
    expect(result.includedCount).toBe(0);
    expect(result.remainingCount).toBe(1);
  });

  it('does not dedupe entries that share description but differ in suggested backend/model', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [
        {
          id: '1',
          description: 'Prefer Claude for UI work',
          suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          suggestedModelId: 'claude-sonnet-4-5',
        },
        {
          id: '2',
          description: 'Prefer Claude for UI work',
          suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          suggestedModelId: 'claude-opus-4-6',
        },
      ],
      maxChars: 10_000,
    });

    expect(result.includedCount).toBe(2);
    expect(result.text).toContain('Prefer Claude for UI work');
    expect(result.text).toContain('backend=agent:claude');
    expect(result.text).toContain('model=claude-sonnet-4-5');
  });

  it('distinguishes built-in and configured ACP backend targets in the fingerprint', () => {
    const builtIn = normalizeExecutionRunsGuidanceFingerprintV1({
      id: '1',
      description: 'Use the review preset',
      suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
    });
    const configured = normalizeExecutionRunsGuidanceFingerprintV1({
      id: '2',
      description: 'Use the review preset',
      suggestedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review' },
    });

    expect(builtIn).not.toBe(configured);
  });

  it('adds an overflow note when rules exceed the max char budget', () => {
    const entry1 = { id: '1', description: 'Rule one' };
    const entry2 = { id: '2', description: 'Rule two is intentionally longer than the overflow note' };

    const full = buildExecutionRunsGuidanceBlockV1({ entries: [entry1, entry2], maxChars: 10_000 });
    const customBlock = full.text.slice(full.text.indexOf('# Custom Execution-Run Rules'));
    const ruleTwoStart = customBlock.indexOf('\n- Rule two');
    expect(ruleTwoStart).toBeGreaterThan(0);

    const overflowNote = '- (+1 more rules in settings)';
    const capped = buildExecutionRunsGuidanceBlockV1({
      entries: [entry1, entry2],
      // Budget that fits the first rule plus the overflow note, but not the second rule.
      maxChars: ruleTwoStart + 1 + overflowNote.length,
    });

    expect(capped.includedCount).toBe(1);
    expect(capped.remainingCount).toBe(1);
    expect(capped.text).toContain(overflowNote);
    const cappedCustomBlock = capped.text.slice(capped.text.indexOf('# Custom Execution-Run Rules'));
    expect(cappedCustomBlock.length).toBeLessThanOrEqual(ruleTwoStart + 1 + overflowNote.length);
  });

  it('omits the rules overflow note when it would exceed the max char budget', () => {
    const entry1 = { id: '1', description: 'Rule one' };
    const entry2 = { id: '2', description: 'Rule two' };

    const full = buildExecutionRunsGuidanceBlockV1({ entries: [entry1, entry2], maxChars: 10_000 });
    const customBlock = full.text.slice(full.text.indexOf('# Custom Execution-Run Rules'));
    const ruleTwoStart = customBlock.indexOf('\n- Rule two');
    expect(ruleTwoStart).toBeGreaterThan(0);

    const capped = buildExecutionRunsGuidanceBlockV1({
      entries: [entry1, entry2],
      maxChars: ruleTwoStart,
    });

    expect(capped.includedCount).toBe(1);
    expect(capped.remainingCount).toBe(1);
    expect(capped.text).not.toContain('more rules in settings');
    const cappedCustomBlock = capped.text.slice(capped.text.indexOf('# Custom Execution-Run Rules'));
    expect(cappedCustomBlock.length).toBeLessThanOrEqual(ruleTwoStart);
  });

  it('excludes disabled entries', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [
        { id: '1', description: 'Enabled rule' },
        { id: '2', description: 'Disabled rule', enabled: false },
      ],
      maxChars: 10_000,
    });

    expect(result.text).toContain('Enabled rule');
    expect(result.text).not.toContain('Disabled rule');
  });

  it('appends example tool calls when present', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [
        {
          id: '1',
          description: 'Prefer Claude for UI work',
          exampleToolCalls: ['mcp.execution.run', 'mcp.execution.list'],
        },
      ],
      maxChars: 10_000,
    });

    expect(result.text).toContain('## Example tool calls (MCP)');
    expect(result.text).toContain('- mcp.execution.run');
    expect(result.text).toContain('- mcp.execution.list');
  });

  it('uses discovery-first Happier-managed run guidance when rules are present', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [
        {
          id: '1',
          description: 'Delegate reviews to a review run',
          suggestedIntent: 'review',
        },
      ],
      maxChars: 10_000,
    });

    expect(result.text).toContain('Happier-Managed Runs');
    expect(result.text).toContain('Custom Execution-Run Rules');
    expect(result.text).toContain('action_spec_search');
    expect(result.text).toContain('action_spec_get');
    expect(result.text).toContain('action_options_resolve');
    expect(result.text).toContain('action_execute');
    expect(result.text).toContain('provider/backend');
    expect(result.text).toContain('not parallelism slots');
    expect(result.text).not.toContain('execution_run_start');
  });
});
