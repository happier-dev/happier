import { describe, expect, it } from 'vitest';

import { deriveNewPermissionRequests } from './deriveNewPermissionRequests';

describe('deriveNewPermissionRequests', () => {
  it('returns empty when next has no requests', () => {
    expect(deriveNewPermissionRequests({}, null)).toEqual([]);
    expect(deriveNewPermissionRequests({}, {})).toEqual([]);
  });

  it('returns only newly-added requests (by id)', () => {
    const prev = {
      r1: { tool: 'Bash', arguments: { command: 'ls' } },
    };
    const next = {
      r1: { tool: 'Bash', arguments: { command: 'ls' } },
      r2: { tool: 'Read', arguments: { path: '/tmp/a' } },
    };

    expect(deriveNewPermissionRequests(prev, next)).toEqual([
      { requestId: 'r2', toolName: 'Read', toolArgs: { path: '/tmp/a' } },
    ]);
  });

  it('ignores requests with non-string tool names', () => {
    const prev = {};
    const next = {
      r1: { tool: 123, arguments: { secret: 'x' } },
      r2: { tool: '', arguments: { secret: 'y' } },
      r3: { tool: 'Bash', arguments: { command: 'pwd' } },
    };

    expect(deriveNewPermissionRequests(prev, next)).toEqual([
      { requestId: 'r3', toolName: 'Bash', toolArgs: { command: 'pwd' } },
    ]);
  });

  it('orders results by createdAt (ascending) when present, otherwise by id', () => {
    const prev = {};
    const next = {
      b: { tool: 'Bash', arguments: { command: 'b' }, createdAt: 2 },
      a: { tool: 'Bash', arguments: { command: 'a' }, createdAt: 1 },
      c: { tool: 'Bash', arguments: { command: 'c' } },
    };

    expect(deriveNewPermissionRequests(prev, next).map((r) => r.requestId)).toEqual(['a', 'b', 'c']);
  });
});

