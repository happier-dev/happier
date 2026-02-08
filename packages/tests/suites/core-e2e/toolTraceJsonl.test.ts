import { describe, expect, it } from 'vitest';

import { hasToolCall, parseToolTraceJsonl } from '../../src/testkit/toolTraceJsonl';

describe('core e2e: tool-trace JSONL helpers', () => {
  it('parses valid lines and ignores invalid JSON lines', () => {
    const raw = [
      JSON.stringify({ v: 1, protocol: 'codex', kind: 'tool-call', payload: { name: 'Bash' } }),
      '{not-json',
      '   ',
      JSON.stringify({ v: 1, protocol: 'codex', kind: 'tool-result', payload: { name: 'Bash' } }),
    ].join('\n');

    const events = parseToolTraceJsonl(raw);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('tool-call');
    expect(events[1]?.kind).toBe('tool-result');
  });

  it('matches tool calls with optional command substring checks', () => {
    const events = parseToolTraceJsonl(
      JSON.stringify({
        v: 1,
        protocol: 'codex',
        kind: 'tool-call',
        payload: { name: 'Bash', input: { command: 'echo TRACE_OK' } },
      }),
    );

    expect(hasToolCall(events, { protocol: 'codex', name: 'Bash' })).toBe(true);
    expect(hasToolCall(events, { protocol: 'codex', name: 'Bash', commandSubstring: 'TRACE_OK' })).toBe(true);
    expect(hasToolCall(events, { protocol: 'codex', name: 'Bash', commandSubstring: 'MISSING' })).toBe(false);
  });
});
