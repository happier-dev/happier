import { describe, expect, it } from 'vitest';

import { resolveInitialClaudeRemoteMetaState } from './resolveInitialClaudeRemoteMetaState';

describe('resolveInitialClaudeRemoteMetaState', () => {
  it('seeds claude remote meta state from account defaults', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSources: 'user_project',
        claudeRemoteAdvancedOptionsJson: '{"plugins":[]}',
      },
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    expect(resolved.claudeRemoteSettingSources).toBe('user_project');
    // Normalized by applyClaudeRemoteMetaState.
    expect(resolved.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');
  });
});

