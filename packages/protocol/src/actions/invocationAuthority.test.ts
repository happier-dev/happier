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
    for (const surface of ['voice', 'plugin', 'api'] as const) expect(resolveInvocationAuthority({ credential: 'account', surface })).toBe('account_automation');
  });
  it('approve permits decisions but never token/security mutations', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: true };
    expect(canCredentialDecideV1({ authority: 'account_automation', grant })).toBe(true);
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('approval.request.decide'), authority: 'account_automation', grant })).toEqual({ ok: true });
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('account.apiTokens.create'), authority: 'account_automation', grant })).toEqual({ ok: false, errorCode: 'present_user_required' });
  });
  it('admits host agent permission answers without widening external credential authority', () => {
    const spec = getActionSpec('session.permission.respond');
    for (const surface of ['agent', 'mcp', 'api', 'cli', 'rpc', 'plugin', 'ui', 'voice'] as const) {
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }))
        .toEqual(surface === 'agent' || surface === 'mcp' ? { ok: true } : { ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface,
        hasExternalCredential: true })).toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation',
        grant: API_TOKEN_FULL_GRANT_V1, surface })).toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, surface })).toEqual({ ok: true });
    }
  });
  it('admits surface-control automation without granting human decision authority', () => {
    for (const actionId of ['browser.control.takeControl', 'browser.control.handBack', 'computer.targets.list',
      'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack',
      'computer.permissions.openSettings', 'browser.sandbox.install'] as const) {
      expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec(actionId),
        authority: 'account_automation', grant: null, surface: 'agent' }), actionId).toEqual({ ok: true });
    }
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
