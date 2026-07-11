import { describe, expect, it } from 'vitest';

import {
  ProviderBindingAuthorizationTicketV1Schema,
  ProviderProbeAuthorizationV1Schema,
} from './v1.js';

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

  it('accepts only the canonical exact probe-request fingerprint owner', () => {
    const authorization = {
      v: 1,
      id: 'probe_authorization_1',
      machineId: 'machine_1',
      endpointSetFingerprint: 'endpoint-set:v1:a',
      credentialDestinationFingerprint: 'credential-destination:v1:a',
      probeRequestFingerprint: 'probe-request:v1:a',
      selectedSecretBindingId: null,
      selectedSecretRecordFingerprint: null,
      use: 'probe',
      expiresAt: 100,
    };
    expect(ProviderProbeAuthorizationV1Schema.safeParse(authorization).success).toBe(true);
    expect(ProviderProbeAuthorizationV1Schema.safeParse({
      ...authorization,
      probeRequestFingerprint: 'catalog:v1:not-an-exact-request',
    }).success).toBe(false);
    expect(ProviderProbeAuthorizationV1Schema.safeParse({
      ...authorization,
      probeRequestFingerprint: ' probe-request:v1:a ',
    }).success).toBe(false);
  });
});
