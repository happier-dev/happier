import { describe, expect, it } from 'vitest';
import { resolveRoleSelectionV1, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol';
import { resolveReviewRunReviewerInstructions, resolveExecutionRunRoleV1 } from './reviewRole';

describe('review Run Reviewer role', () => {
  it('uses the typed current catalog and refuses unavailable override authority', () => {
    expect(resolveExecutionRunRoleV1({ roleId: 'builder', accountRoleOverrides: { status: 'ready', overrides: {
      builder: { roleId: 'builder', workspaceWrites: 'deny' },
    } } })?.workspaceWrites).toBe('deny');
    expect(() => resolveExecutionRunRoleV1({ roleId: 'builder', accountRoleOverrides: {
      status: 'unavailable', reason: 'catalog-loading',
    } })).toThrow(expect.objectContaining({ code: 'account_role_overrides_unavailable' }));
  });
  it('consumes the accepted role selection without rereading changed Account instructions', () => {
    const role = resolveRoleSelectionV1({ roleId: 'scout',
      settingsOverrides: { scout: { roleId: 'scout', instructionsOverride: 'Accepted instructions' } } });
    if (!role.ok) throw new Error('Scout fixture must resolve');
    expect(resolveExecutionRunRoleV1({ roleId: 'scout', resolvedRole: role.selection,
      accountRoleOverrides: { status: 'ready', overrides: { scout: { roleId: 'scout', instructionsOverride: 'Later instructions' } } },
    })?.instructions).toBe('Accepted instructions');
    expect(() => resolveExecutionRunRoleV1({ roleId: 'reviewer', resolvedRole: role.selection }))
      .toThrow(expect.objectContaining({ code: 'role_target_unavailable' }));
  });

  it.each(['unknown', 'disabled'] as const)('refuses an unavailable %s role with the canonical typed refusal', (roleId) => {
    expect(() => resolveExecutionRunRoleV1({ roleId,
      accountRoleOverrides: { status: 'ready', overrides: {} },
      sessionMetadata: { work: { sessionRolesV1: { overrides: {}, sessionRoles: {
        disabled: { roleId: 'disabled', name: 'Disabled', instructions: '', enabled: false,
          runsAs: { kind: 'background_run', intent: 'task' }, workspaceWrites: 'deny', secondOpinion: 'off' },
      }, notes: '' } } },
    })).toThrow(expect.objectContaining({ code: 'role_target_unavailable' }));
  });
  it('consumes canonical account and Session overrides instead of copying built-in text', () => {
    expect(resolveReviewRunReviewerInstructions({
      accountRoleOverrides: { status: 'ready', overrides: { reviewer: { roleId: 'reviewer', instructionsOverride: 'Account review instructions.' } } },
    })).toBe('Account review instructions.');
    expect(resolveReviewRunReviewerInstructions({
      accountRoleOverrides: { status: 'ready', overrides: { reviewer: { roleId: 'reviewer', instructionsOverride: 'Account review instructions.' } } },
      sessionMetadata: { work: { sessionRolesV1: { overrides: { reviewer: { roleId: 'reviewer', instructionsOverride: 'Session review instructions.' } }, sessionRoles: {}, notes: '' } } },
    })).toBe('Session review instructions.');
  });

  it('uses the complete inherited Reviewer snapshot without reading the lead Account settings', () => {
    const resolved = resolveRoleSelectionV1({
      roleId: 'reviewer',
      settingsOverrides: { reviewer: { roleId: 'reviewer', instructionsOverride: 'Inherited evidence requirements.' } },
    });
    if (!resolved.ok) throw new Error('The fixture Reviewer role must resolve');
    const sessionRolesV1 = snapshotSessionRolesAtSpawnV1({
      leadSessionId: 'cross-owner-lead', roles: { reviewer: resolved.selection },
    });
    expect(resolveReviewRunReviewerInstructions({ sessionMetadata: { work: { sessionRolesV1 } } })).toBe('Inherited evidence requirements.');
  });
});
