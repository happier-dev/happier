import { describe, expect, it } from 'vitest';

import { validateNormalizedToolFixturesV2 } from '../../src/testkit/providers/toolSchemas/validateToolSchemas';

describe('providers: normalized tool schema validation (V2)', () => {
  it('accepts known canonical tools and validates per-tool input/output schemas', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Bash': [
        {
          v: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: {
            callId: 'c1',
            id: 'm1',
            name: 'Bash',
            input: {
              _happier: {
                v: 2,
                protocol: 'acp',
                provider: 'opencode',
                rawToolName: 'execute',
                canonicalToolName: 'Bash',
              },
              _raw: { any: 'thing' },
              command: 'echo hello',
            },
          },
        },
      ],
      'acp/opencode/tool-result/Bash': [
        {
          v: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-result',
          payload: {
            callId: 'c1',
            id: 'm2',
            output: {
              _happier: {
                v: 2,
                protocol: 'acp',
                provider: 'opencode',
                rawToolName: 'execute',
                canonicalToolName: 'Bash',
              },
              _raw: { any: 'thing' },
              stdout: 'hello\n',
              exit_code: 0,
            },
          },
        },
      ],
    };

    const res = validateNormalizedToolFixturesV2({ fixturesExamples });
    expect(res.ok).toBe(true);
  });

  it('does not fail when tool name is unknown to the protocol package (forward compatible)', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/future/tool-call/FutureTool': [
        {
          v: 1,
          protocol: 'acp',
          provider: 'future',
          kind: 'tool-call',
          payload: {
            callId: 'c1',
            id: 'm1',
            name: 'FutureTool',
            input: {
              _happier: {
                v: 2,
                protocol: 'acp',
                provider: 'future',
                rawToolName: 'future_tool',
                canonicalToolName: 'FutureTool',
              },
              _raw: { any: 'thing' },
              someNewKey: { nested: true },
            },
          },
        },
      ],
    };

    const res = validateNormalizedToolFixturesV2({ fixturesExamples });
    expect(res.ok).toBe(true);
  });

  it('fails when a normalized tool-call is missing _happier metadata', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Bash': [
        {
          v: 1,
          protocol: 'acp',
          provider: 'opencode',
          kind: 'tool-call',
          payload: {
            callId: 'c1',
            id: 'm1',
            name: 'Bash',
            input: {
              command: 'echo hello',
            },
          },
        },
      ],
    };

    const res = validateNormalizedToolFixturesV2({ fixturesExamples });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toContain('missing _happier');
  });

  it('does not require _happier metadata for raw Claude tool trace events', () => {
    const fixturesExamples: Record<string, unknown> = {
      'claude/claude/tool-call/Read': [
        {
          v: 1,
          protocol: 'claude',
          provider: 'claude',
          kind: 'tool-call',
          payload: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
          },
        },
      ],
      'claude/claude/tool-result/Read': [
        {
          v: 1,
          protocol: 'claude',
          provider: 'claude',
          kind: 'tool-result',
          payload: {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      ],
    };

    const res = validateNormalizedToolFixturesV2({ fixturesExamples });
    expect(res.ok).toBe(true);
  });

  it('fails when raw Claude tool trace events do not match the expected envelope', () => {
    const fixturesExamples: Record<string, unknown> = {
      'claude/claude/tool-call/Read': [
        {
          v: 1,
          protocol: 'claude',
          provider: 'claude',
          kind: 'tool-call',
          payload: {
            // Missing `type: tool_use` and `id`
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
          },
        },
      ],
    };

    const res = validateNormalizedToolFixturesV2({ fixturesExamples });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toContain('claude tool-use payload');
  });
});
