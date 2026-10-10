import { describe, expect, it } from 'vitest';
import { createWorkspaceWritesPolicyPreparation } from './workspaceWritesPolicyPreparation';

describe('native workspace policy preparation', () => {
  it('removes an installed Role ceiling after the acknowledged Session no longer selects a Role', async () => {
    let nativeCeiling: 'allow' | 'deny' = 'allow';
    // Native configuration only applies explicit ceilings; omission leaves its prior state intact.
    const prepare = createWorkspaceWritesPolicyPreparation({ update: async workspaceWrites => {
      if (workspaceWrites === 'allow' || workspaceWrites === 'deny') nativeCeiling = workspaceWrites;
      return { status: 'applied', timing: 'current_window' };
    } });
    expect(await prepare('deny')).toEqual({ ok: true });
    expect(nativeCeiling).toBe('deny');
    expect(await prepare(undefined)).toEqual({ ok: true });
    expect(nativeCeiling).toBe('allow');
  });

  it('does not require native Role configuration when there is no Role ceiling to enforce', async () => {
    const prepare = createWorkspaceWritesPolicyPreparation({ update: async () => ({ status: 'unsupported', timing: 'not_applicable',
      reason: 'native_agent_configuration_unsupported' }) });
    expect(await prepare(undefined)).toEqual({ ok: true });
    expect(await prepare('deny')).toEqual({ ok: false, errorCode: 'role_policy_unenforceable' });
    const fieldUnsupported = createWorkspaceWritesPolicyPreparation({ update: async () => ({ status: 'unsupported', timing: 'not_applicable',
      reason: 'role_policy_unenforceable' }) });
    expect(await fieldUnsupported(undefined)).toEqual({ ok: false, errorCode: 'role_policy_unenforceable' });
  });
  it('does not relax a provider before the canonical role mutation is staged', async () => {
    const applied: string[] = [];
    // Native Agent configuration is an external plugin boundary.
    const prepare = createWorkspaceWritesPolicyPreparation({ update: async (workspaceWrites) => {
      applied.push(workspaceWrites); return { status: 'applied', timing: 'current_window' };
    } });
    expect(await prepare('allow', { authority: 'present_user', surface: 'ui' })).toEqual({ ok: true });
    expect(applied).toEqual([]);
    expect(await prepare('deny', { authority: 'present_user', surface: 'ui' })).toEqual({ ok: true });
    expect(applied).toEqual(['deny']);
    expect(await prepare('allow')).toEqual({ ok: true });
    expect(applied).toEqual(['deny', 'allow']);
  });
  it('surfaces restart and absent configuration support without admitting a role effect', async () => {
    const restart = createWorkspaceWritesPolicyPreparation({ update: async () => ({ status: 'failed', reason: 'role_policy_restart_required' }) });
    expect(await restart('deny')).toEqual({ ok: false, errorCode: 'role_policy_restart_required' });
    const unavailable = createWorkspaceWritesPolicyPreparation({ update: async () => undefined });
    expect(await unavailable('deny')).toEqual({ ok: false, errorCode: 'role_policy_unenforceable' });
  });
});
