import { describe, expect, it } from 'vitest';

import { isConnectedServiceCredentialMutationSupersededError } from './connectedServiceSettingsErrors';

describe('connected-service settings errors', () => {
  it('recognizes a stale guarded credential mutation', () => {
    expect(isConnectedServiceCredentialMutationSupersededError({
      code: 'connect_credential_mutation_superseded',
      status: 409,
    })).toBe(true);
    expect(isConnectedServiceCredentialMutationSupersededError({
      code: 'connect_credential_referenced_by_group',
      status: 409,
    })).toBe(false);
  });
});
