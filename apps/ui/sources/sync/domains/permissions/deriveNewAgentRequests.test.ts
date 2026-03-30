import { describe, expect, it } from 'vitest';

import { deriveNewAgentRequests } from './deriveNewAgentRequests';

describe('deriveNewAgentRequests', () => {
  it('returns empty when next has no requests', () => {
    expect(deriveNewAgentRequests({}, null)).toEqual([]);
    expect(deriveNewAgentRequests({}, {})).toEqual([]);
  });

  it('returns only newly-added requests (by id)', () => {
    const prev = {
      r1: { tool: 'Bash', arguments: { command: 'ls' } },
    };
    const next = {
      r1: { tool: 'Bash', arguments: { command: 'ls' } },
      r2: { tool: 'Read', arguments: { path: '/tmp/a' } },
    };

    expect(deriveNewAgentRequests(prev, next)).toEqual([
      { requestId: 'r2', requestKind: 'permission', toolName: 'Read', toolArgs: { path: '/tmp/a' } },
    ]);
  });

  it('ignores requests with non-string tool names', () => {
    const prev = {};
    const next = {
      r1: { tool: 123, arguments: { secret: 'x' } },
      r2: { tool: '', arguments: { secret: 'y' } },
      r3: { tool: 'Bash', arguments: { command: 'pwd' } },
    };

    expect(deriveNewAgentRequests(prev, next)).toEqual([
      { requestId: 'r3', requestKind: 'permission', toolName: 'Bash', toolArgs: { command: 'pwd' } },
    ]);
  });

  it('orders results by createdAt (ascending) when present, otherwise by id', () => {
    const prev = {};
    const next = {
      b: { tool: 'Bash', arguments: { command: 'b' }, createdAt: 2 },
      a: { tool: 'Bash', arguments: { command: 'a' }, createdAt: 1 },
      c: { tool: 'Bash', arguments: { command: 'c' } },
    };

    expect(deriveNewAgentRequests(prev, next).map((r) => r.requestId)).toEqual(['a', 'b', 'c']);
  });

  it('preserves user_action request kind and infers it for AskUserQuestion', () => {
    const prev = {};
    const next = {
      explicit: { tool: 'SomeInteractiveTool', kind: 'user_action', arguments: { foo: 'bar' } },
      inferred: { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Continue?' }] } },
    };

    expect(deriveNewAgentRequests(prev, next)).toEqual([
      { requestId: 'explicit', requestKind: 'user_action', toolName: 'SomeInteractiveTool', toolArgs: { foo: 'bar' } },
      {
        requestId: 'inferred',
        requestKind: 'user_action',
        toolName: 'AskUserQuestion',
        toolArgs: { questions: [{ question: 'Continue?' }] },
      },
    ]);
  });
});
