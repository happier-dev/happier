import { describe, expect, it } from 'vitest';
import { createWorkspaceWritesPolicyPreparation } from './workspaceWritesPolicyPreparation';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

describe('native workspace policy preparation', () => {
  it('preserves a native configuration refusal instead of turning it into a context dependency failure', async () => {
    const diagnostic = { code: 'opencode_configuration_rejected', severity: 'error' as const,
      message: 'Model is not selectable; Bearer synthetic-private-token' };
    // The native Agent configuration port is an external plugin boundary.
    const prepare = createWorkspaceWritesPolicyPreparation({ update: async () => ({
      status: 'failed', reason: diagnostic.message, diagnostic,
    }) });
    const prepared = await prepare(undefined);
    expect(prepared).toMatchObject({ ok: false, diagnostic });
    if (prepared.ok) throw new Error('Expected a refused configuration');
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'opencode',
      preparingPrompt: true, error: Object.assign(new Error(prepared.errorCode), prepared), occurredAt: 100 });
    expect(issue).toMatchObject({ code: diagnostic.code, source: 'agent_session_error' });
    expect(issue.sanitizedPreview).toContain('Model is not selectable');
    expect(JSON.stringify(issue)).not.toContain('synthetic-private-token');
  });
  it('keeps an unenforceable Role policy out of context-document recovery when the runtime has no native diagnostic', async () => {
    const prepare = createWorkspaceWritesPolicyPreparation({ update: async () => ({
      status: 'unsupported', reason: 'native_agent_configuration_unsupported',
    }) });
    const prepared = await prepare('deny');
    if (prepared.ok) throw new Error('Expected a refused Role policy');
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', preparingPrompt: true,
      error: Object.assign(new Error(prepared.errorCode), prepared), occurredAt: 100 });
    expect(issue).toMatchObject({ code: 'role_policy_unenforceable', source: 'agent_session_error' });
  });
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
    expect(await prepare('deny')).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
    const fieldUnsupported = createWorkspaceWritesPolicyPreparation({ update: async () => ({ status: 'unsupported', timing: 'not_applicable',
      reason: 'role_policy_unenforceable' }) });
    expect(await fieldUnsupported(undefined)).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
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
    expect(await restart('deny')).toMatchObject({ ok: false, errorCode: 'role_policy_restart_required' });
    const unavailable = createWorkspaceWritesPolicyPreparation({ update: async () => undefined });
    expect(await unavailable('deny')).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
  });
});
