import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('pi compaction turn outcome', () => {
  it('is published through a narrow plugin agent runtime subpath and preserves post-final compaction ordering', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./agent/runtime/compaction', {
      types: './dist/agent/runtime/compaction/index.d.ts',
      default: './dist/agent/runtime/compaction/index.js',
    });

    const { resolvePiCompactionTurnOutcome } = await import('./index.js');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: false,
        lastAssistantStopReason: 'stop',
        lastCompactionEnd: { willRetry: false, errorMessage: null },
      }),
    ).toBe('pause');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: 'stop',
        lastCompactionEnd: { willRetry: false, errorMessage: 'You have hit your usage limit' },
      }),
    ).toBe('completed_post_final');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: 'stop',
        lastCompactionEnd: { willRetry: false, errorMessage: null },
      }),
    ).toBe('completed_post_final');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: null,
        lastCompactionEnd: { willRetry: false, errorMessage: 'overflow recovery failed' },
      }),
    ).toBe('terminal_failure');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: null,
        lastCompactionEnd: {
          payload: { phase: 'failed', errorCode: 'context_limit' },
          willRetry: false,
          errorMessage: null,
        },
      }),
    ).toBe('terminal_failure');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: 'error',
        lastCompactionEnd: { willRetry: false, errorMessage: 'context still too large' },
      }),
    ).toBe('terminal_failure');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: false,
        lastAssistantStopReason: 'error',
        lastCompactionEnd: { willRetry: true, errorMessage: 'transient' },
      }),
    ).toBe('pause');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: 'length',
        lastCompactionEnd: { willRetry: false, errorMessage: null },
      }),
    ).toBe('pause');

    expect(
      resolvePiCompactionTurnOutcome({
        agentSettled: true,
        lastAssistantStopReason: 'stop',
        lastCompactionEnd: null,
      }),
    ).toBe('pause');
  });
});
