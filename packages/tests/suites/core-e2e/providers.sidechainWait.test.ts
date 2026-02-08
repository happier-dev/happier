import { describe, expect, it } from 'vitest';

import { findFirstToolCallIdByName } from '../../src/testkit/providers/harness';

describe('providers harness: sidechain wait helpers', () => {
  it('finds the first tool-call id for a given tool name', () => {
    const events = [
      { kind: 'tool-call', payload: { name: 'Bash', callId: 'call_1' } },
      { kind: 'tool-call', payload: { name: 'Task', callId: 'call_task_1' } },
      { kind: 'tool-call', payload: { name: 'Task', callId: 'call_task_2' } },
    ] as any[];

    expect(findFirstToolCallIdByName(events, 'Task')).toBe('call_task_1');
    expect(findFirstToolCallIdByName(events, 'Bash')).toBe('call_1');
    expect(findFirstToolCallIdByName(events, 'Nope')).toBeNull();
  });
});

