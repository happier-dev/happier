import { describe, expect, it } from 'vitest';
import { combineTerminalPresentUserPolicies, resolveInvocationAuthority } from './invocationAuthority.js';
import { canCredentialDecideV1, resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveSocketRpcSessionAuthorization } from '../rpc/index.js';

describe('verified invocation authority', () => {
  it('combines terminal policies most restrictively', () => {
    expect(combineTerminalPresentUserPolicies(undefined, null)).toBe('allowed');
    expect(combineTerminalPresentUserPolicies('allowed', 'disallowed')).toBe('disallowed');
  });
  it('resolves credential, surface and terminal policy without caller claims', () => {
    expect(resolveInvocationAuthority({ credential: 'terminal', surface: 'cli', terminalPolicy: 'allowed' })).toBe('present_user');
    expect(resolveInvocationAuthority({ credential: 'terminal', surface: 'rpc', terminalPolicy: 'disallowed' })).toBe('account_automation');
    expect(resolveInvocationAuthority({ credential: 'terminal', surface: 'cli' })).toBe('account_automation');
    expect(resolveInvocationAuthority({ credential: 'account', surface: 'ui' })).toBe('present_user');
    expect(resolveInvocationAuthority({ credential: 'account', surface: 'voice' })).toBe('account_automation');
    expect(resolveInvocationAuthority({ credential: 'none', surface: 'ui' })).toBe('account_automation');
    expect(resolveInvocationAuthority({ credential: 'none', surface: 'ui', localUiInteraction: true })).toBe('present_user');
    expect(resolveInvocationAuthority({ credential: 'terminal', surface: 'ui', localUiInteraction: true })).toBe('account_automation');
    expect(resolveInvocationAuthority({ credential: 'none', surface: 'voice', localUiInteraction: true })).toBe('account_automation');
    for (const surface of ['plugin', 'api'] as const) expect(resolveInvocationAuthority({ credential: 'account', surface })).toBe('account_automation');
    for (const credential of ['terminal', 'api_token', 'plugin', 'agent', 'none'] as const) {
      expect(resolveInvocationAuthority({ credential, surface: 'voice', terminalPolicy: 'allowed' })).toBe('account_automation');
    }
  });
  it('approve permits decisions but never token/security mutations', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: true };
    expect(canCredentialDecideV1({ authority: 'account_automation', grant })).toBe(true);
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('approval.request.decide'), authority: 'account_automation', grant })).toEqual({ ok: true });
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('account.apiTokens.create'), authority: 'account_automation', grant })).toEqual({ ok: false, errorCode: 'present_user_required' });
  });
  it('delegates only request decisions to the Account Voice host while its preference is enabled', () => {
    for (const actionId of ['approval.request.decide', 'session.permission.respond', 'session.user_action.answer'] as const) {
      expect(resolveInvocationAuthority({ credential: 'account', surface: 'voice', actionId,
        voiceCanApproveRequests: true })).toBe('present_user');
      for (const voiceCanApproveRequests of [false, undefined]) {
        expect(resolveInvocationAuthority({ credential: 'account', surface: 'voice', actionId,
          voiceCanApproveRequests })).toBe('account_automation');
      }
      for (const surface of ['agent', 'mcp', 'plugin', 'api', 'cli'] as const) {
        expect(resolveInvocationAuthority({ credential: 'account', surface, actionId,
          voiceCanApproveRequests: true })).toBe('account_automation');
      }
      for (const credential of ['agent', 'plugin', 'terminal', 'api_token', 'none'] as const) {
        expect(resolveInvocationAuthority({ credential, surface: 'voice', actionId,
          voiceCanApproveRequests: true })).toBe('account_automation');
      }
    }
    for (const actionId of ['settings.set', 'session.stop', 'account.apiTokens.create'] as const) {
      expect(resolveInvocationAuthority({ credential: 'account', surface: 'voice', actionId,
        voiceCanApproveRequests: true })).toBe('account_automation');
    }
  });
  it('admits host decisions through surface approval policy without widening external credential authority', () => {
    const spec = getActionSpec('session.permission.respond');
    for (const surface of ['agent', 'mcp', 'api', 'cli', 'rpc', 'plugin', 'ui', 'voice'] as const) {
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }))
        .toEqual(surface !== 'api' ? { ok: true } : { ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface,
        hasExternalCredential: true })).toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation',
        grant: API_TOKEN_FULL_GRANT_V1, surface })).toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, surface })).toEqual({ ok: true });
    }
  });
  it('admits a credentialed Home approval mint without a second presence floor', () => {
    // requestPrincipal has authenticated the original Account/terminal. Its
    // mint has no local surface; the receiving Action still owns approval policy.
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('approval.request.decide'),
      authority: 'account_automation', grant: null })).toEqual({ ok: true });
  });
  it('admits surface-control automation without granting human decision authority', () => {
    for (const actionId of ['browser.control.takeControl', 'browser.control.handBack', 'computer.targets.list',
      'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack',
      'computer.permissions.openSettings', 'browser.sandbox.install'] as const) {
      expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec(actionId),
        authority: 'account_automation', grant: null, surface: 'agent' }), actionId).toEqual({ ok: true });
    }
  });
  it('authors pass-up without accepting an answer or permission decision', () => {
    const spec = getActionSpec('session.user_action.answer');
    expect(spec.requiredAuthority).toBe('present_user');
    for (const schema of [spec.inputSchema, spec.surfaceBindings?.plugin?.inputSchema]) {
      expect(schema?.safeParse({ requestId: 'q1', disposition: 'pass_up' }).success).toBe(true);
      for (const response of [{ decision: 'approve' }, { answers: [{ question: 'Branch?', values: ['dev'] }] },
        { updatedPermissions: {} }, { allowedTools: ['Bash'] }]) {
        expect(schema?.safeParse({ requestId: 'q1', disposition: 'pass_up', ...response }).success).toBe(false);
      }
    }
  });
  it('admits Voice question answers only as person-approval proposals while pass-up retains manager origin', () => {
    const spec = getActionSpec('session.user_action.answer');
    for (const actionInput of [
      { requestId: 'q1', answers: [{ question: 'Revision?', values: ['42'] }] },
      { requestId: 'q1', decision: 'reject' },
    ]) {
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput, authority: 'account_automation',
        grant: null, surface: 'voice' })).toEqual({ ok: true });
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput, authority: 'account_automation',
        grant: null, surface: 'voice', hasExternalCredential: true }))
        .toEqual({ ok: false, errorCode: 'present_user_required' });
    }
    expect(resolveCredentialActionAdmissionV1({ spec, actionInput: { requestId: 'q1', disposition: 'pass_up' },
      authority: 'account_automation', grant: null, surface: 'voice' }))
      .toEqual({ ok: false, errorCode: 'present_user_required' });
  });
  it('admits automation only to request fresh-folder consent, never to supply it as human authority', () => {
    const spec = getActionSpec('session.open');
    const actionInput = { sessionId: 's1', approvedNewDirectoryCreation: true };
    for (const surface of ['agent', 'mcp', 'api', 'cli', 'ui', 'plugin', 'rpc', 'voice'] as const) {
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput: { sessionId: 's1' },
        authority: 'account_automation', grant: null, surface })).toEqual({ ok: true });
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput, authority: 'account_automation', grant: null, surface }))
        .toEqual(surface === 'agent' || surface === 'mcp' || surface === 'plugin' ? { ok: true } : { ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput, authority: 'present_user', grant: null, surface }))
        .toEqual({ ok: true });
      expect(resolveCredentialActionAdmissionV1({ spec, actionInput, authority: 'account_automation',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, surface, hasExternalCredential: true }))
        .toEqual({ ok: false, errorCode: 'present_user_required' });
    }
  });
  it('abort requires input capability and the current-turn Action admission', () => {
    expect(resolveSocketRpcSessionAuthorization('s1:abort')).toMatchObject({ authority: 'submitAgentInput', actionId: 'session.turn.cancel' });
  });
});
