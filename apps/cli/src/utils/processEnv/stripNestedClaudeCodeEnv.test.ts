import { describe, expect, it } from 'vitest';

import { stripNestedClaudeCodeEnv } from './stripNestedClaudeCodeEnv';

describe('stripNestedClaudeCodeEnv', () => {
  it('removes nested-session detection environment variables without mutating input', () => {
    const input: NodeJS.ProcessEnv = {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'some-parent',
    };

    const output = stripNestedClaudeCodeEnv(input);

    expect(output.PATH).toBe('/bin');
    expect(output.CLAUDECODE).toBeUndefined();
    expect(output.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

    // Input should remain unchanged (callers often reuse process.env).
    expect(input.CLAUDECODE).toBe('1');
    expect(input.CLAUDE_CODE_ENTRYPOINT).toBe('some-parent');
  });
});

