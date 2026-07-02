import { describe, expect, it } from 'vitest';

import { mapCodexRolloutLineToExternalMessages } from './transcript.js';
import type { CodexRolloutAction } from './actions.js';

describe('mapCodexRolloutLineToExternalMessages', () => {
  it('filters harness blobs and preserves stable external transcript rows for rollout actions', () => {
    const actions: readonly CodexRolloutAction[] = [
      { type: 'user-text', text: '# AGENTS.md instructions\nignore this blob' },
      { type: 'user-text', text: 'Investigate external transcript paging parity' },
      { type: 'assistant-text', text: 'Working on it' },
      { type: 'tool-call', callId: 'call-1', name: 'read_file', input: { path: 'README.md' } },
      { type: 'tool-result', callId: 'call-1', output: { ok: true } },
    ];

    const items = mapCodexRolloutLineToExternalMessages({
      fileRelPath: 'sessions/rollout-test.jsonl',
      lineStartOffsetBytes: 42,
      lineValue: { timestamp: '2026-03-06T12:34:56.000Z' },
      actions,
    });

    expect(items).toHaveLength(4);
    expect(items.map((item) => item.id)).toEqual([
      'codex:sessions/rollout-test.jsonl:000000000042:001',
      'codex:sessions/rollout-test.jsonl:000000000042:002',
      'codex:sessions/rollout-test.jsonl:000000000042:003',
      'codex:sessions/rollout-test.jsonl:000000000042:004',
    ]);
    expect(items.map((item) => item.createdAtMs)).toEqual([
      Date.parse('2026-03-06T12:34:56.000Z'),
      Date.parse('2026-03-06T12:34:56.000Z'),
      Date.parse('2026-03-06T12:34:56.000Z'),
      Date.parse('2026-03-06T12:34:56.000Z'),
    ]);
    expect(items[0]?.raw).toEqual({
      role: 'user',
      content: { type: 'text', text: 'Investigate external transcript paging parity' },
    });
    expect(items[1]?.raw).toEqual({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'message',
          message: 'Working on it',
        },
      },
    });
    expect(items[2]?.raw).toEqual({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-call',
          callId: 'call-1',
          name: 'read_file',
          input: { path: 'README.md' },
          id: 'codex:sessions/rollout-test.jsonl:000000000042:003',
        },
      },
    });
    expect(items[3]?.raw).toEqual({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-call-result',
          callId: 'call-1',
          output: { ok: true },
          id: 'codex:sessions/rollout-test.jsonl:000000000042:004',
        },
      },
    });
  });
});
