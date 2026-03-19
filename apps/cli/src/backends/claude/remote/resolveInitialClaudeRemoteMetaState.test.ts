import { describe, expect, it } from 'vitest';

import { resolveInitialClaudeRemoteMetaState } from './resolveInitialClaudeRemoteMetaState';

describe('resolveInitialClaudeRemoteMetaState', () => {
  it('defaults to Agent SDK enabled when account defaults omit the flag', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {},
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    // Default should be enabled unless explicitly disabled by user settings.
    expect(resolved.claudeLocalPermissionBridgeEnabled).toBe(true);
  });

  it('seeds claude remote meta state from account defaults', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project'],
        claudeLocalPermissionBridgeEnabled: true,
        claudeLocalPermissionBridgeWaitIndefinitely: true,
        claudeLocalPermissionBridgeTimeoutSeconds: 600,
        claudeRemoteAdvancedOptionsJson: '{"plugins":[]}',
      },
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    expect((resolved as any).claudeRemoteSettingSourcesV2).toEqual(['user', 'project']);
    expect((resolved as any).claudeLocalPermissionBridgeEnabled).toBe(true);
    expect((resolved as any).claudeLocalPermissionBridgeWaitIndefinitely).toBe(true);
    expect((resolved as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(600);
    // Normalized by applyClaudeRemoteMetaState.
    expect(resolved.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');
  });
});
