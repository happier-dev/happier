import { describe, expect, it } from 'vitest';

import { resolveClaudeRemoteLaunchRuntimeIssueCause } from './createLaunchController';

describe('Claude remote launch runtime issue classification', () => {
  it('maps Claude Code process exits to primary-session process_exit issues', () => {
    expect(resolveClaudeRemoteLaunchRuntimeIssueCause(
      new Error('Claude Code process exited with code 17'),
    )).toBe('process_exit');
  });

  it('keeps non-exit launch failures as provider status errors', () => {
    expect(resolveClaudeRemoteLaunchRuntimeIssueCause(new Error('401 Unauthorized'))).toBe('status_error');
  });
});
