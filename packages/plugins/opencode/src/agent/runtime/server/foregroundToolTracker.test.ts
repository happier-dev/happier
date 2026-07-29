import { describe, expect, it } from 'vitest';

import { createOpenCodeForegroundToolTracker, type OpenCodeToolPart } from './foregroundToolTracker.js';

function tool(callID: string, status: string): OpenCodeToolPart {
  return {
    sessionID: 'ses-1',
    callID,
    tool: 'bash',
    state: { status },
  };
}

describe('createOpenCodeForegroundToolTracker', () => {
  it('tracks only explicitly observed live foreground tool identities until terminal observation', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.observeToolPart({ part: tool('call-1', 'running') });
    expect(tracker.hasActiveToolCalls()).toBe(true);

    tracker.observeToolPart({ part: tool('call-1', 'completed') });
    expect(tracker.hasActiveToolCalls()).toBe(false);
  });

  it('does not expose a history or session-next observation API', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    expect(tracker).not.toHaveProperty('observeSessionNextTool');
    expect(tracker).not.toHaveProperty('getActiveSessionIds');
  });
});
