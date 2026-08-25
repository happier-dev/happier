import { describe, expect, it } from 'vitest';
import { accountSettingsParse, buildBackendTargetKey } from '@happier-dev/protocol';

import { resolvePermissionModeSeedForAgentStart } from './permissionModeSeed';

describe('resolvePermissionModeSeedForAgentStart', () => {
  it('prefers explicit permission mode over account defaults', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: 'read-only',
      inferredPermissionMode: null,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'yolo' } },
    });
    expect(res).toEqual({ mode: 'read-only', source: 'explicit' });
  });

  it('uses inferred permission mode when explicit is missing', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'claude',
      explicitPermissionMode: undefined,
      inferredPermissionMode: 'yolo',
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'safe-yolo' } },
    });
    expect(res).toEqual({ mode: 'yolo', source: 'inferred' });
  });

  it('uses account defaults from the canonical parsed projection for a built-in agent', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'opencode' });
    // Same hazard as the configured-ACP case below: the session runtime passes
    // the PARSED Account Settings, so a fixture keyed by this legacy builder
    // could not fail when the two key vocabularies diverged.
    const accountSettings = accountSettingsParse({
      sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'safe-yolo' },
    });
    expect(Object.keys(accountSettings.sessionDefaultPermissionModeByTargetKey))
      .not.toContain(targetKey);

    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'opencode',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings,
    });
    expect(res).toEqual({ mode: 'safe-yolo', source: 'account_default' });
  });

  it('uses configured ACP backend target defaults from the canonical parsed projection', () => {
    const presetTargetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    // The session runtime passes the PARSED Account Settings, whose catalog
    // rewrites this legacy key to its canonical V2 spelling. Keying the fixture
    // with the same builder this module used to call could not fail when the
    // two vocabularies diverged, so the Account default was silently ignored.
    const accountSettings = accountSettingsParse({
      sessionDefaultPermissionModeByTargetKey: {
        [presetTargetKey]: 'safe-yolo',
      },
    });
    expect(Object.keys(accountSettings.sessionDefaultPermissionModeByTargetKey))
      .not.toContain(presetTargetKey);

    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings,
    });
    expect(res).toEqual({ mode: 'safe-yolo', source: 'account_default' });
  });

  it('clamps codex-like plan defaults to read-only (fail-closed)', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'plan' } },
    });
    expect(res).toEqual({ mode: 'read-only', source: 'account_default' });
  });

  it('keeps plan defaults for claude (not clamped)', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'claude',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'plan' } },
    });
    expect(res).toEqual({ mode: 'plan', source: 'account_default' });
  });

  it('falls back to default when no valid candidates are present', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'gemini',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'nope' } },
    });
    expect(res).toEqual({ mode: 'default', source: 'fallback' });
  });

  it('treats legacy provider tokens as aliases (acceptEdits -> safe-yolo, bypassPermissions -> yolo)', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const res1 = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'acceptEdits' } },
    });
    expect(res1).toEqual({ mode: 'safe-yolo', source: 'account_default' });

    const res2 = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'bypassPermissions' } },
    });
    expect(res2).toEqual({ mode: 'yolo', source: 'account_default' });
  });
});
