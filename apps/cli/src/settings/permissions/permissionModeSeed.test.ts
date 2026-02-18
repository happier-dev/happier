import { describe, expect, it } from 'vitest';

import { resolvePermissionModeSeedForAgentStart } from './permissionModeSeed';

describe('resolvePermissionModeSeedForAgentStart', () => {
  it('prefers explicit permission mode over account defaults', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: 'read-only',
      inferredPermissionMode: null,
      accountSettings: { sessionDefaultPermissionModeByAgent: { codex: 'yolo' } },
    });
    expect(res).toEqual({ mode: 'read-only', source: 'explicit' });
  });

  it('uses inferred permission mode when explicit is missing', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'claude',
      explicitPermissionMode: undefined,
      inferredPermissionMode: 'yolo',
      accountSettings: { sessionDefaultPermissionModeByAgent: { claude: 'safe-yolo' } },
    });
    expect(res).toEqual({ mode: 'yolo', source: 'inferred' });
  });

  it('uses account defaults when explicit and inferred are missing', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'opencode',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { opencode: 'safe-yolo' } },
    });
    expect(res).toEqual({ mode: 'safe-yolo', source: 'account_default' });
  });

  it('clamps codex-like plan defaults to read-only (fail-closed)', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { codex: 'plan' } },
    });
    expect(res).toEqual({ mode: 'read-only', source: 'account_default' });
  });

  it('keeps plan defaults for claude (not clamped)', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'claude',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { claude: 'plan' } },
    });
    expect(res).toEqual({ mode: 'plan', source: 'account_default' });
  });

  it('falls back to default when no valid candidates are present', () => {
    const res = resolvePermissionModeSeedForAgentStart({
      agentId: 'gemini',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { gemini: 'nope' } },
    });
    expect(res).toEqual({ mode: 'default', source: 'fallback' });
  });

  it('treats legacy provider tokens as aliases (acceptEdits -> safe-yolo, bypassPermissions -> yolo)', () => {
    const res1 = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { codex: 'acceptEdits' } },
    });
    expect(res1).toEqual({ mode: 'safe-yolo', source: 'account_default' });

    const res2 = resolvePermissionModeSeedForAgentStart({
      agentId: 'codex',
      explicitPermissionMode: undefined,
      inferredPermissionMode: undefined,
      accountSettings: { sessionDefaultPermissionModeByAgent: { codex: 'bypassPermissions' } },
    });
    expect(res2).toEqual({ mode: 'yolo', source: 'account_default' });
  });
});

