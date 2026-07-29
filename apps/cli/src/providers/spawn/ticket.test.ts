import { describe, expect, it } from 'vitest';

import {
  ProviderConnectionIdSchema,
  createProviderErrorV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

import {
  mintProviderBindingAuthorizationTicket,
  revalidateProviderBindingAuthorizationTicket,
  type ProviderBindingAuthorizationState,
} from './ticket';

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');

function state(overrides: Partial<ProviderBindingAuthorizationState> = {}): ProviderBindingAuthorizationState {
  return {
    connectionId,
    connectionRevision: 3,
    machineId: 'machine-a',
    connectionSecurityFingerprint: 'connection-security:v1:one',
    bindingSecurityFingerprint: 'binding-security:v1:one',
    grantFingerprint: 'account-grant:v1:one',
    selectedSecretBindingId: 'secret-a',
    selectedSecretRecordFingerprint: 'saved-secret-record:v1:one',
    ...overrides,
  };
}

describe('provider binding authorization tickets', () => {
  it('revalidates the exact security-relevant state without depending on display state', () => {
    const ticket = mintProviderBindingAuthorizationTicket(state());

    expect(revalidateProviderBindingAuthorizationTicket(ticket, state())).toEqual({ ok: true });
  });

  it.each([
    ['connectionRevision', 4],
    ['connectionSecurityFingerprint', 'connection-security:v1:two'],
    ['bindingSecurityFingerprint', 'binding-security:v1:two'],
    ['grantFingerprint', 'account-grant:v1:two'],
    ['selectedSecretBindingId', 'secret-b'],
    ['selectedSecretRecordFingerprint', 'saved-secret-record:v1:two'],
  ] as const)('rejects a changed %s before commit', (key, value) => {
    const ticket = mintProviderBindingAuthorizationTicket(state());
    const result = revalidateProviderBindingAuthorizationTicket(ticket, state({ [key]: value }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'provider_authorization_changed',
        connectionId: 'pc_gateway',
        machineId: 'machine-a',
      }) as ProviderErrorV1,
    });
  });

  it('returns the precise current refusal instead of masking a deletion as a generic race', () => {
    const ticket = mintProviderBindingAuthorizationTicket(state());
    const currentError = createProviderErrorV1('provider_connection_not_found', {
      connectionId,
      machineId: 'machine-a',
    });

    expect(revalidateProviderBindingAuthorizationTicket(ticket, currentError)).toEqual({
      ok: false,
      error: currentError,
    });
  });
});
