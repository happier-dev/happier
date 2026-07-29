import { describe, expect, it } from 'vitest';

import { applyClaudeUnifiedTerminalLaunchIntent } from './launchIntent.js';

describe('applyClaudeUnifiedTerminalLaunchIntent', () => {
  it('replaces every conflicting continuation, session-id, and fork flag with one exact resume ID', () => {
    const args = applyClaudeUnifiedTerminalLaunchIntent([
      '--model', 'claude-opus-4-6',
      '--continue',
      '-c',
      '--resume', 'stale-long',
      '-r', 'stale-short',
      '--resume=stale-equals',
      '-r=stale-short-equals',
      '--session-id', 'stale-session',
      '--session-id=stale-session-equals',
      '--fork-session',
      '--fork-session=stale-fork',
      '--permission-mode', 'default',
    ], {
      kind: 'resume_native',
      providerSessionId: 'provider-session-exact',
    });

    expect(args).toEqual([
      '--model', 'claude-opus-4-6',
      '--permission-mode', 'default',
      '--resume', 'provider-session-exact',
    ]);
  });

  it('does not add a resume argument for a new session', () => {
    expect(applyClaudeUnifiedTerminalLaunchIntent([
      '--model', 'claude-sonnet-4-5',
      '--resume', 'stale-session',
      '--fork-session',
    ], {
      kind: 'new_session',
    })).toEqual(['--model', 'claude-sonnet-4-5']);
  });
});
