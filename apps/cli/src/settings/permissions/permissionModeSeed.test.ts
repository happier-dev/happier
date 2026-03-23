import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

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

  it('uses account defaults when explicit and inferred are missing', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'opencode' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'opencode',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'safe-yolo' } },
    });
    expect(res).toEqual({ mode: 'safe-yolo', source: 'account_default' });
  });

  it('prefers configured ACP backend target defaults over built-in family defaults', () => {
    const presetTargetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    const familyTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' });
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: {
        sessionDefaultPermissionModeByTargetKey: {
          [familyTargetKey]: 'read-only',
          [presetTargetKey]: 'safe-yolo',
        },
      },
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
