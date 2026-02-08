import { describe, expect, it } from 'vitest';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { DiffProcessor } from './diffProcessor';

type EmittedMessage = DiffToolCall | DiffToolResult;

function collectByType(messages: EmittedMessage[]): {
  calls: DiffToolCall[];
  results: DiffToolResult[];
} {
  const calls = messages.filter((message): message is DiffToolCall => message.type === 'tool-call');
  const results = messages.filter((message): message is DiffToolResult => message.type === 'tool-call-result');
  return { calls, results };
}

describe('DiffProcessor (Codex)', () => {
  it('coalesces multiple turn_diff snapshots and emits one tool call on flush', () => {
    const sent: EmittedMessage[] = [];
    const processor = new DiffProcessor((msg) => sent.push(msg));

    processor.processDiff('diff-1');
    processor.processDiff('diff-2');

    // During the turn we only capture the latest snapshot; we do not emit per-snapshot tool calls.
    expect(sent).toHaveLength(0);

    processor.flushTurn?.();

    const { calls, results } = collectByType(sent);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('CodexDiff');
    expect(calls[0].input.unified_diff).toBe('diff-2');

    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe(calls[0].callId);
  });

  it('emits nothing when flushed without snapshots', () => {
    const sent: EmittedMessage[] = [];
    const processor = new DiffProcessor((msg) => sent.push(msg));

    processor.flushTurn();
    expect(sent).toEqual([]);
  });

  it('drops captured diff snapshots after reset', () => {
    const sent: EmittedMessage[] = [];
    const processor = new DiffProcessor((msg) => sent.push(msg));

    processor.processDiff('diff-before-reset');
    processor.reset();
    processor.flushTurn();

    expect(sent).toEqual([]);
  });

  it('supports setting the message callback after construction', () => {
    const sent: EmittedMessage[] = [];
    const processor = new DiffProcessor();

    processor.setMessageCallback((msg) => sent.push(msg));
    processor.processDiff('diff-late-callback');
    processor.flushTurn();

    const { calls, results } = collectByType(sent);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.unified_diff).toBe('diff-late-callback');
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe(calls[0].callId);
  });
});
