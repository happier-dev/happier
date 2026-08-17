import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
  isConnectedServiceCredentialReferencedByGroupError,
  resolveConnectedServiceSettingsErrorMessage,
} from './connectedServiceSettingsErrors';

describe('connected-service settings errors', () => {
  it('recognizes a credential still referenced by a pool', () => {
    expect(isConnectedServiceCredentialReferencedByGroupError({
      code: 'connect_credential_referenced_by_group',
      status: 409,
    })).toBe(true);
    expect(isConnectedServiceCredentialReferencedByGroupError({
      code: 'connect_credential_mutation_superseded',
      status: 409,
    })).toBe(false);
  });

  it('explains an invalid account configuration rather than falling back to generic copy', () => {
    const message = resolveConnectedServiceSettingsErrorMessage({
      code: 'connected_account_configuration_invalid',
    });

    expect(message).toBe(t('connectedServices.account.configurationInvalid'));
    expect(message).not.toBe(t('connectedServices.errors.generic'));
  });

  it('does not surface an untyped Error message', () => {
    const message = resolveConnectedServiceSettingsErrorMessage(
      new Error('remote failure: token=never-render-this'),
    );

    expect(message).toBe(t('connectedServices.errors.generic'));
    expect(message).not.toContain('token=never-render-this');
  });
});
