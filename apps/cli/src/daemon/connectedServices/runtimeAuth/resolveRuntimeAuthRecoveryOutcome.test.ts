import { describe, expect, it } from 'vitest';

import {
  isLocallyCompleteWithoutProof,
  isProvenRuntimeAuthRecoverySuccess,
  resolveRuntimeAuthRecoveryProof,
} from './resolveRuntimeAuthRecoveryOutcome';

describe('resolveRuntimeAuthRecoveryProof', () => {
  it('keeps exact switch application as progress until a provider-qualified outcome arrives', () => {
    const result = {
      status: 'switch_attempted',
      result: { verificationByServiceId: { 'openai-codex': { status: 'verified' } } },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('rejects weakly_verified adoption as provider recovery proof', () => {
    const result = {
      status: 'switch_attempted',
      result: { verificationByServiceId: { 'openai-codex': { status: 'weakly_verified' } } },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
  });

  it('proves fresh-candidate when fromProfileId differs from activeProfileId', () => {
    const result = {
      status: 'switch_attempted',
      result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'backup' },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBe('fresh_candidate_selected');
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('does NOT prove a same-account hot apply (fromProfileId === activeProfileId)', () => {
    const result = {
      status: 'switch_attempted',
      result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'primary' },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('does NOT prove a switch without fromProfileId', () => {
    const result = {
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup' },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
  });

  it('does NOT prove a bare credential_refreshed', () => {
    expect(resolveRuntimeAuthRecoveryProof({ status: 'credential_refreshed' })).toBeNull();
    expect(isProvenRuntimeAuthRecoverySuccess({ status: 'credential_refreshed' })).toBe(false);
  });

  it('does NOT prove a bare ok:true', () => {
    const result = { status: 'switch_attempted', result: { ok: true } };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('does NOT prove an observed_generation', () => {
    const result = { status: 'switch_attempted', result: { status: 'observed_generation', generation: 5 } };
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });
});

describe('isLocallyCompleteWithoutProof', () => {
  it('flags credential_refreshed as intermediate (not terminal)', () => {
    expect(isLocallyCompleteWithoutProof({ status: 'credential_refreshed' })).toBe(true);
  });

  it('flags an unverified switch as intermediate', () => {
    expect(isLocallyCompleteWithoutProof({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup' },
    })).toBe(true);
  });

  it('flags observed_generation and ok:true as intermediate', () => {
    expect(isLocallyCompleteWithoutProof({
      status: 'switch_attempted',
      result: { status: 'observed_generation' },
    })).toBe(true);
    expect(isLocallyCompleteWithoutProof({
      status: 'switch_attempted',
      result: { ok: true },
    })).toBe(true);
  });

  it('does not flag a proven switch as intermediate', () => {
    expect(isLocallyCompleteWithoutProof({
      status: 'switch_attempted',
      result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'backup' },
    })).toBe(true);
  });

  it('does not flag an unrelated terminal/error result', () => {
    expect(isLocallyCompleteWithoutProof({
      status: 'switch_attempted',
      result: { status: 'no_eligible_member' },
    })).toBe(false);
  });
});
