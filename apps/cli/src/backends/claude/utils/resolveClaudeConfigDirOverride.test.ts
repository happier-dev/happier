import { describe, it, expect } from 'vitest';
import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';

describe('resolveClaudeConfigDirOverride', () => {
  it('returns null when CLAUDE_CONFIG_DIR is missing or blank', () => {
    expect(resolveClaudeConfigDirOverride({} satisfies NodeJS.ProcessEnv)).toBeNull();
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '' } satisfies NodeJS.ProcessEnv)).toBeNull();
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '   ' } satisfies NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns the trimmed CLAUDE_CONFIG_DIR value', () => {
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '/tmp/claude' } satisfies NodeJS.ProcessEnv)).toBe(
      '/tmp/claude',
    );
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '  /tmp/claude  ' } satisfies NodeJS.ProcessEnv)).toBe(
      '/tmp/claude',
    );
  });
});
