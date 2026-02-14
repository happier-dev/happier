import { describe, expect, it } from 'vitest';

import { resolveInitialClaudeRemoteMetaState } from './resolveInitialClaudeRemoteMetaState';

describe('resolveInitialClaudeRemoteMetaState', () => {
  it('defaults to Agent SDK enabled when account defaults omit the flag', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {},
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
  });

  it('seeds claude remote meta state from account defaults', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSources: 'user_project',
        claudeLocalPermissionBridgeEnabled: true,
        claudeLocalPermissionBridgeWaitIndefinitely: false,
        claudeLocalPermissionBridgeTimeoutSeconds: 600,
        claudeRemoteAdvancedOptionsJson: '{"plugins":[]}',
      },
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    expect(resolved.claudeRemoteSettingSources).toBe('user_project');
    expect((resolved as any).claudeLocalPermissionBridgeEnabled).toBe(true);
    expect((resolved as any).claudeLocalPermissionBridgeWaitIndefinitely).toBe(false);
    expect((resolved as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(600);
    // Normalized by applyClaudeRemoteMetaState.
    expect(resolved.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');
  });
});
