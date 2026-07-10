import { describe, expect, it } from 'vitest';

import { ProviderBindingAuthorizationTicketV1Schema } from './v1.js';

describe('ProviderBindingAuthorizationTicketV1Schema', () => {
  it('requires SavedSecret id and persisted-record fingerprint together', () => {
    const base = {
      connectionId: 'pc_1', machineId: 'machine_1', connectionSecurityFingerprint: 'connection:v1:a',
      bindingSecurityFingerprint: 'binding:v1:a', grantFingerprint: 'grant:v1:a',
      selectedSecretBindingId: null, selectedSecretRecordFingerprint: null,
    };
    expect(ProviderBindingAuthorizationTicketV1Schema.safeParse(base).success).toBe(true);
    expect(ProviderBindingAuthorizationTicketV1Schema.safeParse({ ...base, selectedSecretBindingId: 'secret_1' }).success).toBe(false);
    expect(ProviderBindingAuthorizationTicketV1Schema.safeParse({ ...base, selectedSecretRecordFingerprint: 'secret-record:v1:a' }).success).toBe(false);
  });
});
