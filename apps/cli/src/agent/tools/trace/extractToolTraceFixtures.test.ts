import { describe, expect, it } from 'vitest';
import { extractToolTraceFixturesFromJsonlLines } from './extractToolTraceFixtures';
import { makeTraceEvent, scenarioToolResultThenPermissionRequest, scenarioToolResultThenToolCall, toJsonlLines } from './testEvents.testHelpers';

describe('extractToolTraceFixturesFromJsonlLines', () => {
  it('groups tool events by protocol/provider/kind/tool name', () => {
    const fixtures = extractToolTraceFixturesFromJsonlLines(
      toJsonlLines([
        makeTraceEvent({
          ts: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'read', input: { filePath: '/etc/hosts' } },
        }),
        makeTraceEvent({
          ts: 2,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'message',
          payload: { type: 'message', message: 'hello' },
        }),
        makeTraceEvent({
          ts: 3,
          protocol: 'codex',
          provider: 'codex',
          kind: 'tool-call',
          payload: { type: 'tool-call', name: 'CodexBash', input: { command: 'ls' } },
        }),
      ]),
    );

    expect(fixtures.v).toBe(1);
    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/opencode/tool-call/read', 'codex/codex/tool-call/CodexBash']));
    expect(fixtures.examples['acp/opencode/tool-call/read']).toHaveLength(1);
    expect(fixtures.examples['codex/codex/tool-call/CodexBash']).toHaveLength(1);
    expect(fixtures.examples['acp/opencode/message']).toBeUndefined();
  });

  it('keys tool-result events by tool name even when the tool-call arrives later in the trace', () => {
    const fixtures = extractToolTraceFixturesFromJsonlLines(scenarioToolResultThenToolCall());
    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/opencode/tool-result/read']));
  });

  it('keys tool-result events by tool name when only a permission-request exists (no tool-call)', () => {
    const fixtures = extractToolTraceFixturesFromJsonlLines(scenarioToolResultThenPermissionRequest());
    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/gemini/tool-result/read']));
  });

  it('keys tool-result events by normalized canonical tool name when available (without relying on callId index)', () => {
    const fixtures = extractToolTraceFixturesFromJsonlLines(
      toJsonlLines([
        makeTraceEvent({
          ts: 1,
          protocol: 'acp',
          provider: 'codex',
          kind: 'tool-result',
          payload: {
            type: 'tool-result',
            callId: 'c1',
            output: { stdout: 'ok', _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'execute', canonicalToolName: 'Bash' } },
          },
        }),
        makeTraceEvent({
          ts: 2,
          protocol: 'acp',
          provider: 'codex',
          kind: 'tool-call',
          payload: {
            type: 'tool-call',
            callId: 'c1',
            name: 'exec_command',
            input: { _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'exec_command', canonicalToolName: 'exec_command' } },
          },
        }),
      ]),
    );

    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/codex/tool-result/Bash']));
    expect(fixtures.examples['acp/codex/tool-result/Bash']).toHaveLength(1);
  });

  it('falls back to payload.name for older tool-result events without canonical metadata', () => {
    const fixtures = extractToolTraceFixturesFromJsonlLines(
      toJsonlLines([
        makeTraceEvent({
          ts: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-result',
          payload: {
            type: 'tool-result',
            callId: 'legacy-1',
            name: 'Read',
            output: { content: 'ok' },
          },
        }),
      ]),
    );

    expect(Object.keys(fixtures.examples)).toEqual(expect.arrayContaining(['acp/opencode/tool-result/Read']));
    expect(fixtures.examples['acp/opencode/tool-result/Read']).toHaveLength(1);
  });
});
