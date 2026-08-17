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
    // A Codex rollout exposes a stable replay row, but its native user message
    // carries no origin fact that distinguishes terminal input from a host echo.
    // Do not upgrade this to a terminal-follow admission capability by content.
    expect(items[0]).not.toHaveProperty('userProjection');
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

  it('projects non-JSON tool payloads to canonical JSON nulls', () => {
    const items = mapCodexRolloutLineToExternalMessages({
      fileRelPath: 'sessions/rollout-test.jsonl',
      lineStartOffsetBytes: 17,
      lineValue: {},
      actions: [
        {
          type: 'tool-call',
          callId: 'call-1',
          name: 'read_file',
          input: new Map([['path', 'README.md']]),
        },
        {
          type: 'tool-result',
          callId: 'call-1',
          output: new Map([['ok', true]]),
        },
      ],
    });

    expect(items).toEqual([
      {
        id: 'codex:sessions/rollout-test.jsonl:000000000017:000',
        localId: 'codex:sessions/rollout-test.jsonl:000000000017:000',
        createdAtMs: 0,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: 'call-1',
              name: 'read_file',
              input: null,
              id: 'codex:sessions/rollout-test.jsonl:000000000017:000',
            },
          },
        },
      },
      {
        id: 'codex:sessions/rollout-test.jsonl:000000000017:001',
        localId: 'codex:sessions/rollout-test.jsonl:000000000017:001',
        createdAtMs: 0,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call-result',
              callId: 'call-1',
              output: null,
              id: 'codex:sessions/rollout-test.jsonl:000000000017:001',
            },
          },
        },
      },
    ]);
  });

  it('projects a failed tool result with its authoritative error bit', () => {
    const items = mapCodexRolloutLineToExternalMessages({
      fileRelPath: 'sessions/rollout-test.jsonl',
      lineStartOffsetBytes: 21,
      lineValue: {},
      actions: [{
        type: 'tool-result',
        callId: 'call-failed',
        output: { body: 'failed', success: false },
        isError: true,
      }],
    });

    expect(items[0]?.raw).toEqual({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-call-result',
          callId: 'call-failed',
          output: { body: 'failed', success: false },
          id: 'codex:sessions/rollout-test.jsonl:000000000021:000',
          isError: true,
        },
      },
    });
  });
});
