import { describe, expect, it } from 'vitest';

import { extractToolUseBlocksFromStreamJsonLine } from '../../src/testkit/providers/claude/realClaudeCliProbe';

describe('realClaudeCliProbe', () => {
  it('extracts tool_use ids from assistant stream-json records', () => {
    const input = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'toolu_123', name: 'TaskCreate', input: { description: 'x' } },
        ],
      },
    };

    expect(extractToolUseBlocksFromStreamJsonLine(input)).toEqual([
      { toolUseId: 'toolu_123', name: 'TaskCreate', input: { description: 'x' } },
    ]);
  });
});

