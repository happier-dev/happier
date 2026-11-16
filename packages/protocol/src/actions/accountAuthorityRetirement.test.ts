import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { projectKnownAccountAuthorityRetirementReceipt } from './accountAuthorityRetirement.js';

describe('known Account authority retirement receipts', () => {
  it.each([
    ['account.signOut', 'signed_out'],
    ['account.sessions.signOutEverywhere', 'signed_out'],
    ['account.credentials.forgetAll', 'forgotten'],
    ['account.delete', 'deleted'],
    ['account.delete', 'deleted_cleanup_pending'],
    ['account.delete', 'disabled_pending_completion'],
    ['home.accounts.delete', 'deleted'],
    ['home.accounts.delete', 'disabled_pending_completion'],
    ['session.pending.next', 'opened'],
  ] as const)('preserves only the declared %s completion status', (actionId, status) => {
    expect(projectKnownAccountAuthorityRetirementReceipt(getActionSpec(actionId), { ok: true, result: { status } }))
      .toEqual({ ok: true, result: { status } });
  });

  it('refuses cancellation, failed effects and unvalidated old-Account data', () => {
    const spec = getActionSpec('account.signOut');
    expect(projectKnownAccountAuthorityRetirementReceipt(spec, { ok: true, result: { status: 'cancelled' } })).toBeNull();
    expect(projectKnownAccountAuthorityRetirementReceipt(spec, { ok: false, errorCode: 'failed', error: 'failed' })).toBeNull();
    expect(projectKnownAccountAuthorityRetirementReceipt(spec, { ok: true,
      result: { status: 'signed_out', privateAccountData: 'must-not-leave-the-retired-scope' } })).toBeNull();
  });

  it('never treats an outer approval receipt or an unrelated Action as self-retirement', () => {
    expect(projectKnownAccountAuthorityRetirementReceipt(getActionSpec('approval.request.decide'), { ok: true,
      result: { status: 'executed', execution: { ok: true, result: { status: 'signed_out' } } } })).toBeNull();
    expect(projectKnownAccountAuthorityRetirementReceipt(getActionSpec('account.name.set'), { ok: true,
      result: { status: 'signed_out' } })).toBeNull();
  });

  it('does not disclose an uncommitted or extended Next result after a Home switch', () => {
    const spec = getActionSpec('session.pending.next');
    for (const result of [{ status: 'none' }, { status: 'unavailable' }, { status: 'opened', privateData: 'hidden' }]) {
      expect(projectKnownAccountAuthorityRetirementReceipt(spec, { ok: true, result })).toBeNull();
    }
  });
});
