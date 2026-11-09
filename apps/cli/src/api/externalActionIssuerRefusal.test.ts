import { describe, expect, it } from 'vitest';

import { projectSessionActionIssuerRefusal } from './externalActionIssuerRefusal';

describe('Session Action issuer refusal projection', () => {
  it('preserves the Machine owner target failure without inventing an authorization failure', () => {
    const result = projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization', code: 'target_unavailable',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      failureCause: { errorCode: 'target_unavailable' } });
    expect(result.details).toBeUndefined();
  });

  it('retains the Machine owner diagnostic for an unavailable target', () => {
    const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const result = projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization', code: 'target_unavailable', details,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable', details });
  });

  it('keeps an actual missing issuer authorization classified as forbidden', () => {
    expect(projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization', code: 'invalid_token',
    })).toMatchObject({ ok: false, errorCode: 'action_forbidden',
      details: { reason: 'external_authorization_refused', requiredFact: 'home_minted_authorization' } });
  });
});
