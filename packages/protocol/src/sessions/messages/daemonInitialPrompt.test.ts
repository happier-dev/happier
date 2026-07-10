import { describe, expect, it } from 'vitest';

import { buildDaemonInitialPromptLocalId } from './daemonInitialPrompt.js';

describe('daemonInitialPrompt', () => {
  it('builds the stable local id used to reconcile daemon initial prompts', () => {
    expect(buildDaemonInitialPromptLocalId(' session-1 ')).toBe('daemon-initial-prompt:session-1');
    expect(buildDaemonInitialPromptLocalId('')).toBeNull();
    expect(buildDaemonInitialPromptLocalId(null)).toBeNull();
  });
});
