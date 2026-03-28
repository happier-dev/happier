import { describe, expect, it } from 'vitest';

import {
  buildClaudeRemoteOutgoingMessageMetaExtras,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
} from './claudeRemote.js';

describe('buildClaudeRemoteOutgoingMessageMetaExtras', () => {
  it('uses canonical provider defaults when the persisted settings object omits fields', () => {
    const extras = buildClaudeRemoteOutgoingMessageMetaExtras({});

    expect(extras.claudeRemoteAgentSdkEnabled).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteAgentSdkEnabled);
    expect(extras.claudeCodeExperimentalAgentTeamsEnabled).toBe(
      CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeCodeExperimentalAgentTeamsEnabled,
    );
    expect(extras.claudeLocalPermissionBridgeEnabled).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeLocalPermissionBridgeEnabled);
    expect(extras.claudeLocalPermissionBridgeWaitIndefinitely).toBe(
      CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeLocalPermissionBridgeWaitIndefinitely,
    );
    expect(extras.claudeLocalPermissionBridgeTimeoutSeconds).toBe(
      CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeLocalPermissionBridgeTimeoutSeconds,
    );
    expect(extras.claudeRemoteEnableFileCheckpointing).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteEnableFileCheckpointing);
    expect(extras.claudeRemoteDisableTodos).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteDisableTodos);
    expect(extras.claudeRemoteStrictMcpServerConfig).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteStrictMcpServerConfig);
    expect(extras.claudeRemoteAdvancedOptionsJson).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteAdvancedOptionsJson);

    // Setting sources already have explicit defaulting logic (and legacy mapping).
    expect(extras.claudeRemoteSettingSourcesV2).toEqual(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2);
    // Default V2 includes `local`, so it is not representable via the legacy enum.
    expect(extras.claudeRemoteSettingSources).toBeUndefined();
  });

  it('preserves explicit persisted values (including false)', () => {
    const extras = buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeRemoteAgentSdkEnabled: false,
      claudeLocalPermissionBridgeEnabled: false,
      claudeLocalPermissionBridgeWaitIndefinitely: false,
      claudeLocalPermissionBridgeTimeoutSeconds: 42,
    });

    expect(extras.claudeRemoteAgentSdkEnabled).toBe(false);
    expect(extras.claudeLocalPermissionBridgeEnabled).toBe(false);
    expect(extras.claudeLocalPermissionBridgeWaitIndefinitely).toBe(false);
    expect(extras.claudeLocalPermissionBridgeTimeoutSeconds).toBe(42);
  });
});
