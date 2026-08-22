import { describe, expect, it } from 'vitest';

import { createAcpToolUpdatePolicy } from './acpToolUpdatePolicy';

describe('createAcpToolUpdatePolicy', () => {
  it('keeps state per policy instance, throttles rapid progress, and never drops terminal updates', () => {
    let nowMs = 1_000;
    const create = () => createAcpToolUpdatePolicy({
      minInProgressIntervalMs: 250,
      maxStringChars: 8_192,
    }, { now: () => nowMs });
    const firstSession = create();
    const secondSession = create();
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'same-provider-id',
      status: 'in_progress',
    };

    expect(firstSession.prepare(update)).toEqual(update);
    nowMs += 43;
    expect(firstSession.prepare({ ...update, title: 'new progress' })).toBeNull();
    expect(secondSession.prepare(update)).toEqual(update);
    expect(firstSession.prepare({ ...update, status: 'completed' })).toEqual({
      ...update,
      status: 'completed',
    });
  });

  it('bounds every cumulative string to the declared newest-tail budget', () => {
    const policy = createAcpToolUpdatePolicy({
      minInProgressIntervalMs: 250,
      maxStringChars: 8_192,
    });
    const text = `old-prefix-${'x'.repeat(8_192)}-new-tail`;

    const prepared = policy.prepare({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { text },
    });

    expect((prepared?.rawOutput as { text: string }).text).toHaveLength(8_192);
    expect((prepared?.rawOutput as { text: string }).text).not.toContain('old-prefix');
    expect((prepared?.rawOutput as { text: string }).text).toContain('new-tail');
  });

  it('preserves the original update when no string needs bounding', () => {
    const policy = createAcpToolUpdatePolicy({ maxStringChars: 8_192 });
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
      rawOutput: { text: 'small output' },
    };

    expect(policy.prepare(update)).toBe(update);
  });
});
