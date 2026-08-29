import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1,
  AccountDirectoryCapabilitiesSchema,
  AccountDirectoryHomeDeleteRequestV1Schema,
  AccountDirectoryHomeEntryV1Schema,
  AccountDirectoryHomePutRequestV1Schema,
  AccountDirectoryHomesResponseV1Schema,
  AccountDirectoryLinkDeleteRequestV1Schema,
  AccountDirectoryLinkPutRequestV1Schema,
  AccountDirectoryLinkV1Schema,
  AccountDirectoryMeResponseV1Schema,
  AccountDirectoryPreferredHomePatchRequestV1Schema,
  AccountDirectoryPreferredHomePatchResponseV1Schema,
  AccountDirectoryRouteErrorResponseV1Schema,
  HomeConnectionDescriptorV1Schema,
  HomeLoginAssertionRequestV1Schema,
  HomeLoginAssertionResponseV1Schema,
  HomeLoginAssertionV1Schema,
  HomeLoginRedemptionRequestV1Schema,
  HomeLoginRedemptionResultV1Schema,
  HomeLoginRedemptionResponseV1Schema,
  createHomeLoginAssertionSigningBytesV1,
} from './accountDirectory.js';

const HTTPS_DESCRIPTOR = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_https',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }],
};

const IROH_DESCRIPTOR = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_iroh',
  canonicalServerUrl: 'http://127.0.0.1:43123',
  revision: 7,
  endpoints: [{
    kind: 'iroh' as const,
    endpointId: 'endpoint-home-iroh',
    relayUrls: ['https://relay.example.test'],
    directAddresses: ['192.0.2.10:443'],
  }],
};

const MIXED_DESCRIPTOR = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_mixed',
  canonicalServerUrl: 'https://home.example.test/base',
  revision: 3,
  endpoints: [
    { kind: 'https' as const, url: 'https://home.example.test/base' },
    { kind: 'iroh' as const, endpointId: 'endpoint-home-mixed' },
  ],
};

const ASSERTION = {
  v: 1 as const,
  purpose: 'happier.home-login' as const,
  issuerServerIdentityId: 'srv_account_service',
  issuerSubjectId: 'account-subject-1',
  audienceHomeServerIdentityId: 'srv_home_https',
  clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  issuedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_000_180_000,
  keyId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  signatureBase64Url: 'A'.repeat(86),
};

describe('Account Directory protocol DTOs', () => {
  it('accepts HTTPS-only, Iroh-only, and mixed Home descriptors', () => {
    expect(HomeConnectionDescriptorV1Schema.parse(HTTPS_DESCRIPTOR)).toEqual(HTTPS_DESCRIPTOR);
    expect(HomeConnectionDescriptorV1Schema.parse(IROH_DESCRIPTOR)).toEqual(IROH_DESCRIPTOR);
    expect(HomeConnectionDescriptorV1Schema.parse(MIXED_DESCRIPTOR)).toEqual(MIXED_DESCRIPTOR);
  });

  it('keeps descriptors closed and bounded', () => {
    expect(HomeConnectionDescriptorV1Schema.safeParse({ ...HTTPS_DESCRIPTOR, v: 2 }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({ ...HTTPS_DESCRIPTOR, unexpected: true }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({ ...HTTPS_DESCRIPTOR, revision: 0 }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      canonicalServerUrl: 'ftp://home.example.test',
    }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      homeServerIdentityId: 'not-an-identity',
    }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      endpoints: Array.from({ length: 17 }, () => HTTPS_DESCRIPTOR.endpoints[0]),
    }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      endpoints: [{ kind: 'https', url: 'https://home.example.test', unexpected: true }],
    }).success).toBe(false);
  });

  it('parses the optional accountDirectory capability as one closed family', () => {
    const capability = {
      version: 1 as const,
      homeDirectory: true,
      homeEnrollment: true,
      deviceApproval: false,
      homeLoginAssertion: {
        keyId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        publicKeyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    };
    expect(AccountDirectoryCapabilitiesSchema.parse(capability)).toEqual(capability);
    expect(AccountDirectoryCapabilitiesSchema.safeParse({ ...capability, extra: true }).success).toBe(false);
    expect(AccountDirectoryCapabilitiesSchema.safeParse({ ...capability, version: 2 }).success).toBe(false);
    expect(AccountDirectoryCapabilitiesSchema.safeParse({
      ...capability,
      homeLoginAssertion: { ...capability.homeLoginAssertion, publicKeyBase64Url: 'not-base64url' },
    }).success).toBe(false);
  });

  it('keeps every directory and enrollment request/response strict and caller-owned', () => {
    const homeEntry = {
      v: 1 as const,
      homeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
      canonicalServerUrl: HTTPS_DESCRIPTOR.canonicalServerUrl,
      label: 'Personal Home',
      connectionDescriptor: HTTPS_DESCRIPTOR,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_001,
      preferred: true,
    };
    expect(AccountDirectoryHomeEntryV1Schema.parse(homeEntry)).toEqual(homeEntry);
    expect(AccountDirectoryHomePutRequestV1Schema.parse({
      v: 1,
      label: 'Personal Home',
      connectionDescriptor: HTTPS_DESCRIPTOR,
    })).toMatchObject({ label: 'Personal Home' });
    expect(AccountDirectoryHomeDeleteRequestV1Schema.parse({ v: 1 })).toEqual({ v: 1 });
    expect(AccountDirectoryPreferredHomePatchRequestV1Schema.parse({
      v: 1,
      homeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
    })).toBeTruthy();
    expect(AccountDirectoryPreferredHomePatchRequestV1Schema.parse({
      v: 1,
      homeServerIdentityId: null,
    })).toBeTruthy();
    expect(AccountDirectoryHomesResponseV1Schema.parse({
      v: 1,
      homes: [homeEntry],
      preferredHomeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
    })).toBeTruthy();
    expect(AccountDirectoryPreferredHomePatchResponseV1Schema.parse({
      v: 1,
      homes: [homeEntry],
      preferredHomeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
    })).toBeTruthy();
    expect(AccountDirectoryHomePutRequestV1Schema.safeParse({
      v: 1,
      accountId: 'caller-supplied-account',
      label: 'Personal Home',
      connectionDescriptor: HTTPS_DESCRIPTOR,
    }).success).toBe(false);

    const me = AccountDirectoryMeResponseV1Schema.parse({
      v: 1,
      accountId: 'account-1',
      displayName: 'Ada Lovelace',
      avatar: null,
      linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' }],
    });
    expect(me.linkedAuthenticationMethods).toHaveLength(1);
  });

  it('pins link issuer facts and gives relinking an explicit request field', () => {
    const link = {
      v: 1 as const,
      issuerServerIdentityId: 'srv_account_service',
      issuerSubjectId: 'account-subject-1',
      issuerSigningKeyId: ASSERTION.keyId,
      issuerSigningPublicKeyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(AccountDirectoryLinkV1Schema.parse(link)).toEqual(link);
    expect(AccountDirectoryLinkPutRequestV1Schema.parse({ ...link, relink: true })).toMatchObject({ relink: true });
    expect(AccountDirectoryLinkDeleteRequestV1Schema.parse({ v: 1 })).toEqual({ v: 1 });
    expect(AccountDirectoryLinkPutRequestV1Schema.safeParse({ ...link, accountId: 'account-1' }).success).toBe(false);
    expect(AccountDirectoryLinkV1Schema.safeParse({ ...link, issuerSigningKeyId: 'not-a-sha256-key-id' }).success).toBe(false);
  });

  it('validates assertion request/response and sealed token redemption DTOs', () => {
    expect(HomeLoginAssertionV1Schema.parse(ASSERTION)).toEqual(ASSERTION);
    expect(HomeLoginAssertionRequestV1Schema.parse({
      v: 1,
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      clientBoxPublicKeyBase64: ASSERTION.clientBoxPublicKeyBase64,
    })).toBeTruthy();
    expect(HomeLoginAssertionResponseV1Schema.parse(ASSERTION)).toEqual(ASSERTION);
    expect(HomeLoginRedemptionRequestV1Schema.parse({ v: 1, assertion: ASSERTION })).toEqual({ v: 1, assertion: ASSERTION });
    const authorized = {
      v: 1 as const,
      outcome: 'authorized' as const,
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      sealedHomeTokenBase64Url: 'A'.repeat(64),
      issuedAtMs: ASSERTION.issuedAtMs,
      expiresAtMs: ASSERTION.expiresAtMs,
    };
    expect(HomeLoginRedemptionResponseV1Schema.parse(authorized)).toEqual(authorized);
    expect(HomeLoginRedemptionResultV1Schema.parse({
      v: 1,
      outcome: 'approval_required',
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      approvalId: 'approval-1',
      deviceLabel: null,
      expiresAtMs: ASSERTION.expiresAtMs,
    })).toBeTruthy();
    expect(HomeLoginRedemptionResponseV1Schema.safeParse({
      ...authorized,
      dataKey: 'must-not-cross-this-boundary',
    }).success).toBe(false);
  });

  it('rejects assertion lifetime, key, audience, version, and signature shape violations', () => {
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, expiresAtMs: ASSERTION.issuedAtMs + 119_999 }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, expiresAtMs: ASSERTION.issuedAtMs + 300_001 }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, signatureBase64Url: 'A' }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, clientBoxPublicKeyBase64: 'A' }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, purpose: 'wrong-purpose' }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, audienceHomeServerIdentityId: 'srv_other' }).success).toBe(true);
  });

  it('uses the one domain-separated, length-delimited assertion signing encoding', () => {
    const bytes = createHomeLoginAssertionSigningBytesV1(ASSERTION);
    const bytesAsHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1).toBe('happier.account-directory.home-login.v1');
    expect(bytesAsHex).toBe('00000027686170706965722e6163636f756e742d6469726563746f72792e686f6d652d6c6f67696e2e7631000000013100000012686170706965722e686f6d652d6c6f67696e000000137372765f6163636f756e745f73657276696365000000116163636f756e742d7375626a6563742d310000000e7372765f686f6d655f68747470730000002c414141414141414141414141414141414141414141414141414141414141414141414141414141414141413d0000000d313730303030303030303030300000000d313730303030303138303030300000004030313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566');
  });

  it('exposes typed route errors without leaking credentials', () => {
    expect(ACCOUNT_DIRECTORY_ERROR_CODES_V1).toMatchObject({ invalidAssertionSignature: 'invalid_assertion_signature' });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'invalid_assertion_signature' })).toEqual({
      error: 'invalid_assertion_signature',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.safeParse({ error: 'invalid_token', token: 'secret' }).success).toBe(false);
  });
});
