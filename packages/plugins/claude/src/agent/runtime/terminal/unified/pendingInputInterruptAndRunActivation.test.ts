import { describe, expect, it } from 'vitest';

import { isClaudeUnifiedPendingInputInterruptAndRunEnabled } from './pendingInputInterruptAndRunActivation.js';

describe('Claude Unified pending-input interrupt-and-run activation', () => {
  it('enables terminal hosts that implement the interrupt contract', () => {
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('tmux')).toBe(true);
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('zellij')).toBe(true);
  });
});
