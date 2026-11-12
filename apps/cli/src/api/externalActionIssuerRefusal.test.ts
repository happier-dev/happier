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

  it('keeps an absent issuer decision classified as forbidden', () => {
    expect(projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization',
    })).toMatchObject({ ok: false, errorCode: 'action_forbidden',
      details: { reason: 'external_authorization_refused', requiredFact: 'home_minted_authorization' } });
  });
});


it('retains HTTP refusal cause and correlation through the Session issuer projection', () => {
  const failureCause = { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: 403 } as const;
  for (const code of ['target_not_local', 'credential_scope_denied', 'invalid_token']) {
    expect(projectSessionActionIssuerRefusal({ ok: false, phase: 'mint', requiredFact: 'home_minted_authorization',
      code, requestId: 'mint-request', failureCause, ...(code === 'target_not_local' ? { details: { phase: 'target_installation' } } : {}) }))
      .toMatchObject({ ok: false, errorCode: code, requestId: 'mint-request', failureCause,
        ...(code === 'target_not_local' ? { details: { phase: 'target_installation' } } : {}) });
  }
});
