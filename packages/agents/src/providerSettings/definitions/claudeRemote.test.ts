import { describe, expect, it } from 'vitest';

import {
  buildClaudeRemoteOutgoingMessageMetaExtras,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  CLAUDE_REMOTE_PROVIDER_FIELDS,
} from './claudeRemote.js';

describe('buildClaudeRemoteOutgoingMessageMetaExtras', () => {
  it('keeps idle reclamation opt-in and carries a validated duration', () => {
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({})).toMatchObject({
      claudeRemoteIdleReclaimEnabled: false,
      claudeRemoteIdleReclaimTimeoutMinutes: 30,
    });
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeRemoteIdleReclaimEnabled: true,
      claudeRemoteIdleReclaimTimeoutMinutes: 45,
    })).toMatchObject({ claudeRemoteIdleReclaimEnabled: true, claudeRemoteIdleReclaimTimeoutMinutes: 45 });
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeRemoteIdleReclaimEnabled: 'true',
      claudeRemoteIdleReclaimTimeoutMinutes: 0,
    })).toMatchObject({ claudeRemoteIdleReclaimEnabled: false, claudeRemoteIdleReclaimTimeoutMinutes: 30 });
  });

  it('defaults both unified response locations to app and terminal', () => {
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({})).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'app_and_terminal',
      claudeUnifiedTerminalPermissionResponseLocation: 'app_and_terminal',
    });
  });

  it('preserves a legacy bridge opt-out until each response location is explicitly chosen', () => {
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({ claudeLocalPermissionBridgeEnabled: false })).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'terminal_only',
      claudeLocalPermissionBridgeEnabled: false,
    });
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeLocalPermissionBridgeEnabled: false,
      claudeUnifiedTerminalQuestionResponseLocation: 'app_only',
    })).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'app_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'terminal_only',
      claudeLocalPermissionBridgeEnabled: false,
    });
  });

  it('keeps response locations independent and rejects malformed choices', () => {
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'app_only',
    })).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'app_only',
    });
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeLocalPermissionBridgeEnabled: false,
      claudeUnifiedTerminalQuestionResponseLocation: 'nowhere',
      claudeUnifiedTerminalPermissionResponseLocation: true,
    })).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'terminal_only',
    });
  });

  it('keeps native session history attribution opt-in and carries only explicit booleans', () => {
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({}).claudeCodeIncludeInNativeHistory).toBe(false);
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({ claudeCodeIncludeInNativeHistory: true }).claudeCodeIncludeInNativeHistory).toBe(true);
    expect(buildClaudeRemoteOutgoingMessageMetaExtras({ claudeCodeIncludeInNativeHistory: 'true' }).claudeCodeIncludeInNativeHistory).toBe(false);
  });

  it('exports the canonical unified terminal host values used by the provider schema', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_HOSTS).toEqual(['auto', 'tmux', 'zellij', 'herdr']);
    expect(CLAUDE_REMOTE_PROVIDER_FIELDS.claudeUnifiedTerminalHost.schema.options).toEqual(
      CLAUDE_UNIFIED_TERMINAL_HOSTS,
    );
  });

  it('exports the canonical unified terminal resume-choice values used by the provider schema', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES).toEqual([
      'ask_every_time',
      'resume_from_summary',
      'resume_full_session',
    ]);
    expect(CLAUDE_REMOTE_PROVIDER_FIELDS.claudeUnifiedTerminalResumeChoice.schema.options).toEqual(
      CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
    );
  });

  it('exports the canonical unified terminal workspace-trust values with ask-by-default', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES).toEqual([
      'ask_every_time',
      'always_trust_happier_workspaces',
      'always_reject_happier_workspaces',
    ]);
    expect(CLAUDE_REMOTE_PROVIDER_FIELDS.claudeUnifiedTerminalWorkspaceTrust.schema.options).toEqual(
      CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
    );
    expect(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeUnifiedTerminalWorkspaceTrust).toBe('ask_every_time');
  });

  it('uses canonical provider defaults when the persisted settings object omits fields', () => {
    const extras = buildClaudeRemoteOutgoingMessageMetaExtras({});
    const defaults = CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS as Readonly<Record<string, unknown>>;

    expect(extras.claudeRemoteAgentSdkEnabled).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteAgentSdkEnabled);
    expect(extras.claudeUnifiedTerminalEnabled).toBe(defaults.claudeUnifiedTerminalEnabled);
    expect(extras.claudeUnifiedTerminalHost).toBe(defaults.claudeUnifiedTerminalHost);
    expect(extras.claudeUnifiedTerminalResumeChoice).toBe(defaults.claudeUnifiedTerminalResumeChoice);
    expect(extras.claudeUnifiedTerminalWorkspaceTrust).toBe(defaults.claudeUnifiedTerminalWorkspaceTrust);
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
    expect(extras.claudeRemoteDebugEnabled).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteDebugEnabled);
    expect(extras.claudeRemoteVerboseEnabled).toBe(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteVerboseEnabled);
    expect(extras.claudeRemoteDebugCategories).toEqual(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteDebugCategories);

    // Setting sources already have explicit defaulting logic (and legacy mapping).
    expect(extras.claudeRemoteSettingSourcesV2).toEqual(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2);
    // Default V2 includes `local`, so it is not representable via the legacy enum.
    expect(extras.claudeRemoteSettingSources).toBeUndefined();
  });

  it('preserves explicit persisted values (including false)', () => {
    const extras = buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeRemoteAgentSdkEnabled: false,
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'zellij',
      claudeUnifiedTerminalResumeChoice: 'resume_full_session',
      claudeUnifiedTerminalWorkspaceTrust: 'always_reject_happier_workspaces',
      claudeLocalPermissionBridgeEnabled: false,
      claudeLocalPermissionBridgeWaitIndefinitely: false,
      claudeLocalPermissionBridgeTimeoutSeconds: 42,
      claudeRemoteDebugEnabled: true,
      claudeRemoteVerboseEnabled: true,
      claudeRemoteDebugCategories: ['mcp', 'api', 'api', 'bogus', 'file'],
    });

    expect(extras.claudeRemoteAgentSdkEnabled).toBe(false);
    expect(extras.claudeUnifiedTerminalEnabled).toBe(true);
    expect(extras.claudeUnifiedTerminalHost).toBe('zellij');
    expect(extras.claudeUnifiedTerminalResumeChoice).toBe('resume_full_session');
    expect(extras.claudeUnifiedTerminalWorkspaceTrust).toBe('always_reject_happier_workspaces');
    expect(extras.claudeLocalPermissionBridgeEnabled).toBe(false);
    expect(extras.claudeLocalPermissionBridgeWaitIndefinitely).toBe(false);
    expect(extras.claudeLocalPermissionBridgeTimeoutSeconds).toBe(42);
    expect(extras.claudeRemoteDebugEnabled).toBe(true);
    expect(extras.claudeRemoteVerboseEnabled).toBe(true);
    // Normalized, stable order, invalid dropped.
    expect(extras.claudeRemoteDebugCategories).toEqual(['api', 'mcp', 'file']);
  });

  it('falls back to unified terminal defaults for malformed persisted values', () => {
    const extras = buildClaudeRemoteOutgoingMessageMetaExtras({
      claudeUnifiedTerminalEnabled: 'true',
      claudeUnifiedTerminalHost: 'screen',
      claudeUnifiedTerminalResumeChoice: 'resume_partial_session',
      claudeUnifiedTerminalWorkspaceTrust: 'trust_this_workspace',
    });

    expect(extras.claudeUnifiedTerminalEnabled).toBe(false);
    expect(extras.claudeUnifiedTerminalHost).toBe('auto');
    expect(extras.claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');
    expect(extras.claudeUnifiedTerminalWorkspaceTrust).toBe('ask_every_time');
  });
});
