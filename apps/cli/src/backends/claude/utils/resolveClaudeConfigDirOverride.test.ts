import { describe, it, expect } from 'vitest';
import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';

describe('resolveClaudeConfigDirOverride', () => {
  it('returns null when both CLAUDE_CONFIG_DIR and HAPPIER_CLAUDE_CONFIG_DIR are missing or blank', () => {
    expect(resolveClaudeConfigDirOverride({} satisfies NodeJS.ProcessEnv)).toBeNull();
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '' } satisfies NodeJS.ProcessEnv)).toBeNull();
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '   ' } satisfies NodeJS.ProcessEnv)).toBeNull();
    expect(resolveClaudeConfigDirOverride({ HAPPIER_CLAUDE_CONFIG_DIR: '' } satisfies NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns the trimmed CLAUDE_CONFIG_DIR value', () => {
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '/tmp/claude' } satisfies NodeJS.ProcessEnv)).toBe(
      '/tmp/claude',
    );
    expect(resolveClaudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '  /tmp/claude  ' } satisfies NodeJS.ProcessEnv)).toBe(
      '/tmp/claude',
    );
  });

  it('falls back to HAPPIER_CLAUDE_CONFIG_DIR when CLAUDE_CONFIG_DIR is not set', () => {
    expect(
      resolveClaudeConfigDirOverride({ HAPPIER_CLAUDE_CONFIG_DIR: '  /tmp/happier-claude  ' } satisfies NodeJS.ProcessEnv),
    ).toBe('/tmp/happier-claude');
  });
});
