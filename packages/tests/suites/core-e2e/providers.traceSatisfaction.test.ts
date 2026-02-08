import { describe, expect, it } from 'vitest';

import { checkMaxTraceEvents, hasTraceForKey, scenarioSatisfiedByTrace } from '../../src/testkit/providers/traceSatisfaction';

describe('providers: trace satisfaction correlation', () => {
  it('requires tool-result to correlate to the expected tool via callId', () => {
    const events: any[] = [
      {
        v: 1,
        sessionId: 's1',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'tool-call',
        payload: { callId: 'c1', name: 'Bash', input: {} },
      },
      {
        v: 1,
        sessionId: 's1',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'tool-result',
        payload: { callId: 'c1', output: {} },
      },
    ];

    expect(hasTraceForKey(events as any, 'acp/opencode/tool-result/Bash')).toBe(true);
    expect(scenarioSatisfiedByTrace(events as any, { requiredFixtureKeys: ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'] })).toBe(true);
  });

  it('does not treat an unrelated tool-result as satisfying tool-result/<Tool>', () => {
    const events: any[] = [
      {
        v: 1,
        sessionId: 's1',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'tool-call',
        payload: { callId: 'c1', name: 'Bash', input: {} },
      },
      {
        v: 1,
        sessionId: 's1',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'tool-result',
        payload: { callId: 'c2', output: {} },
      },
    ];

    expect(hasTraceForKey(events as any, 'acp/opencode/tool-result/Bash')).toBe(false);
    expect(scenarioSatisfiedByTrace(events as any, { requiredFixtureKeys: ['acp/opencode/tool-result/Bash'] })).toBe(false);
  });

  it('correlates Claude tool_result to tool_use via tool_use_id', () => {
    const events: any[] = [
      {
        v: 1,
        sessionId: 's1',
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-call',
        payload: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      },
      {
        v: 1,
        sessionId: 's1',
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-result',
        payload: { type: 'tool_result', tool_use_id: 'toolu_1', content: [] },
      },
    ];

    expect(hasTraceForKey(events as any, 'claude/claude/tool-result/Read')).toBe(true);
  });

  it('enforces max trace event limits', () => {
    const events: any[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash', input: {} } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c2', name: 'Bash', input: {} } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-result', payload: { callId: 'c1', output: {} } },
    ];

    expect(checkMaxTraceEvents(events as any, { toolCalls: 1 }).ok).toBe(false);
    expect(checkMaxTraceEvents(events as any, { toolCalls: 2 }).ok).toBe(true);
    expect(checkMaxTraceEvents(events as any, { toolResults: 0 }).ok).toBe(false);
  });
});
