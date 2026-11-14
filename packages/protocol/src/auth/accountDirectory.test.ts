import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES,
  ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES,
  ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES,
  ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
  ACCOUNT_DIRECTORY_CREDENTIAL_DESTINATION_DIGEST_DOMAIN_V1,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1,
  ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1,
  ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1,
  HOME_LOGIN_APPROVALS_HTTP_PATH_V1,
  HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1,
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
  HomeCredentialDestinationV1Schema,
  HomeApplicationOriginV1Schema,
  HomeDeviceApprovalRequestV1Schema,
  HomeDeviceApprovalListV1Schema,
  HomeDeviceApprovalDecisionRequestV1Schema,
  HomeDeviceApprovalDecisionResponseV1Schema,
  HomeLoginAssertionRequestV1Schema,
  HomeLoginAssertionResponseV1Schema,
  HomeLoginAssertionV1Schema,
  HomeLoginCredentialPayloadV1Schema,
  HomeLoginRedemptionRequestV1Schema,
  HomeLoginRedemptionResultV1Schema,
  HomeLoginRedemptionResponseV1Schema,
  createHomeLoginAssertionSigningBytesV1,
  createHomeCredentialDestinationDigestV1,
  createHomeCredentialDestinationV1,
  isHomeCredentialDestinationAllowedV1,
  createHomeLoginRequesterFingerprintV1,
  buildAccountDirectoryHomeHttpPathV1,
  buildAccountDirectoryHomeLoginAssertionHttpPathV1,
  buildAccountDirectoryLinkHttpPathV1,
  buildHomeLoginApprovalDecisionHttpPathV1,
} from './accountDirectory.js';
import { BOX_BUNDLE_MIN_BYTES } from '../crypto/boxBundle.js';
import { encodeBase64 } from '../crypto/base64.js';

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
    endpointId: 'b'.repeat(64),
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
    { kind: 'iroh' as const, endpointId: 'c'.repeat(64) },
  ],
};

const ASSERTION = {
  v: 1 as const,
  purpose: 'happier.home-login' as const,
  issuerServerIdentityId: 'srv_account_service',
  issuerSubjectId: 'account-subject-1',
  audienceHomeServerIdentityId: 'srv_home_https',
  credentialDestinationDigestBase64Url: 'A'.repeat(43),
  clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  issuedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_000_180_000,
  keyId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  signatureBase64Url: 'A'.repeat(86),
};

function plainStoredLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipients: [] };
}

function plainReadLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipientEnvelope: null };
}

describe('Account Directory protocol DTOs', () => {
  it('uses sealed label writes, reader projections, and a nullable bootstrap label', () => {
    const stored = { content: { t: 'plain' as const, v: 'Personal Home' }, recipients: [] };
    const read = { content: stored.content, recipientEnvelope: null };
    const entry = {
      v: 1 as const,
      homeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
      canonicalServerUrl: HTTPS_DESCRIPTOR.canonicalServerUrl,
      label: read,
      connectionDescriptor: HTTPS_DESCRIPTOR,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_001,
      preferred: true,
    };

    expect(AccountDirectoryHomePutRequestV1Schema.safeParse({ v: 1, label: stored, connectionDescriptor: HTTPS_DESCRIPTOR }).success).toBe(true);
    expect(AccountDirectoryHomePutRequestV1Schema.safeParse({ v: 1, label: 'Personal Home', connectionDescriptor: HTTPS_DESCRIPTOR }).success).toBe(false);
    expect(AccountDirectoryHomeEntryV1Schema.safeParse(entry).success).toBe(true);
    expect(AccountDirectoryHomeEntryV1Schema.safeParse({ ...entry, label: stored }).success).toBe(false);
    expect(AccountDirectoryHomeEntryV1Schema.safeParse({ ...entry, label: null }).success).toBe(true);
  });

  it('owns strict Home approval decision DTOs and canonical parameterized paths', () => {
    expect(HomeDeviceApprovalDecisionRequestV1Schema.parse({ decision: 'approve' }))
      .toEqual({ decision: 'approve' });
    expect(HomeDeviceApprovalDecisionRequestV1Schema.safeParse({ decision: 'reject', extra: true }).success)
      .toBe(false);
    expect(HomeDeviceApprovalDecisionResponseV1Schema.parse({ status: 'already_decided' }))
      .toEqual({ status: 'already_decided' });
    expect(HomeDeviceApprovalDecisionResponseV1Schema.safeParse({ status: 'expired' }).success)
      .toBe(false);

    expect(ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1)
      .toBe('/v1/account-directory/homes/:homeServerIdentityId');
    expect(buildAccountDirectoryHomeHttpPathV1('srv_home/a'))
      .toBe('/v1/account-directory/homes/srv_home%2Fa');
    expect(ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1)
      .toBe('/v1/account-directory/homes/:homeServerIdentityId/login-assertion');
    expect(buildAccountDirectoryHomeLoginAssertionHttpPathV1('srv_home/a'))
      .toBe('/v1/account-directory/homes/srv_home%2Fa/login-assertion');
    expect(ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1)
      .toBe('/v1/account/directory-links/:issuerServerIdentityId');
    expect(buildAccountDirectoryLinkHttpPathV1('srv_issuer/a'))
      .toBe('/v1/account/directory-links/srv_issuer%2Fa');
    expect(HOME_LOGIN_APPROVALS_HTTP_PATH_V1).toBe('/v1/auth/home-login/approvals');
    expect(HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1)
      .toBe('/v1/auth/home-login/approvals/:approvalId/decision');
    expect(buildHomeLoginApprovalDecisionHttpPathV1('approval/a'))
      .toBe('/v1/auth/home-login/approvals/approval%2Fa/decision');
  });

  it('owns the strict bounded Home credential payload and requester fingerprint', () => {
    const maximumToken = 't'.repeat(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES);
    const maximalPayload = { token: maximumToken };
    expect(HomeLoginCredentialPayloadV1Schema.safeParse(maximalPayload).success).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(maximalPayload)).byteLength,
    ).toBeLessThanOrEqual(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES);
    // Escape stress: 4096 quote characters serialize to 8192 bytes and must
    // still sit inside the derived bound.
    const escapeStressPayload = {
      token: '"'.repeat(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES),
    };
    expect(HomeLoginCredentialPayloadV1Schema.safeParse(escapeStressPayload).success).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(escapeStressPayload)).byteLength,
    ).toBeLessThanOrEqual(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES);
    expect(ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES).toBe(
      ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES + BOX_BUNDLE_MIN_BYTES,
    );

    const maximumSealedEnvelope = encodeBase64(
      new Uint8Array(ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES).fill(1),
      'base64url',
    );
    const oversizedSealedEnvelope = encodeBase64(
      new Uint8Array(ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES + 1).fill(1),
      'base64url',
    );
    const response = {
      v: 1 as const,
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      sealedHomeTokenBase64Url: maximumSealedEnvelope,
      issuedAtMs: ASSERTION.issuedAtMs,
      expiresAtMs: ASSERTION.expiresAtMs,
    };
    expect(HomeLoginRedemptionResponseV1Schema.safeParse(response).success).toBe(true);
    expect(HomeLoginRedemptionResponseV1Schema.safeParse({
      ...response,
      sealedHomeTokenBase64Url: oversizedSealedEnvelope,
    }).success).toBe(false);

    const ordinaryPayload = { token: 'ordinary-token' };
    expect(HomeLoginCredentialPayloadV1Schema.parse(ordinaryPayload)).toEqual(ordinaryPayload);
    expect(HomeLoginCredentialPayloadV1Schema.safeParse({
      token: '',
    }).success).toBe(false);
    expect(HomeLoginCredentialPayloadV1Schema.safeParse({
      token: `${maximumToken}t`,
    }).success).toBe(false);
    expect(HomeLoginCredentialPayloadV1Schema.safeParse({
      v: 1,
      credentials: { token: 'ordinary-token' },
      connectionDescriptor: HTTPS_DESCRIPTOR,
    }).success).toBe(false);
    expect(HomeLoginCredentialPayloadV1Schema.safeParse({ ...ordinaryPayload, extra: true }).success)
      .toBe(false);
    expect(HomeLoginCredentialPayloadV1Schema.safeParse({ ...maximalPayload, extra: true }).success).toBe(false);

    expect(createHomeLoginRequesterFingerprintV1(
      encodeBase64(new Uint8Array(32).fill(1), 'base64'),
    )).toBe('manQ-MZqE-KNsy-FbcS');
  });

  it('owns the strict Home approval-list contract without an arbitrary cardinality cap', () => {
    const item = {
      approvalId: 'approval-1',
      accountId: 'account-1',
      flow: 'account_assertion' as const,
      requesterBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      issuerServerIdentityId: 'srv_account_service',
      issuerSubjectId: 'account-1',
      deviceLabel: 'Phone',
      status: 'pending' as const,
      expiresAtMs: ASSERTION.expiresAtMs,
      decidedAtMs: null,
    };

    expect(HomeDeviceApprovalRequestV1Schema.parse(item)).toEqual(item);
    expect(HomeDeviceApprovalRequestV1Schema.safeParse({ ...item, flow: 'direct_qr' }).success).toBe(false);
    expect(HomeDeviceApprovalRequestV1Schema.safeParse({ ...item, unexpected: true }).success).toBe(false);
    expect(HomeDeviceApprovalListV1Schema.parse(Array.from({ length: 101 }, (_, index) => ({
      ...item,
      approvalId: `approval-${index}`,
    })))).toHaveLength(101);
  });

  it('accepts HTTPS-only, Iroh-only, and mixed Home descriptors', () => {
    expect(HomeConnectionDescriptorV1Schema.parse(HTTPS_DESCRIPTOR)).toEqual(HTTPS_DESCRIPTOR);
    expect(HomeConnectionDescriptorV1Schema.parse(IROH_DESCRIPTOR)).toEqual(IROH_DESCRIPTOR);
    expect(HomeConnectionDescriptorV1Schema.parse(MIXED_DESCRIPTOR)).toEqual(MIXED_DESCRIPTOR);
  });

  it('owns the strict Home application-origin policy', () => {
    for (const value of [
      'https://home.example.test',
      'https://home.example.test/base',
      'http://localhost:3010',
      'http://127.0.0.2:3010',
      'http://[::1]:3010',
    ]) {
      expect(HomeApplicationOriginV1Schema.parse(value)).toBe(value);
    }
    for (const value of [
      'http://home.example.test',
      'https://user:pass@home.example.test',
      'https://home.example.test?mode=enroll',
      'https://home.example.test#enroll',
      'ftp://home.example.test',
    ]) {
      expect(HomeApplicationOriginV1Schema.safeParse(value).success).toBe(false);
    }
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
      canonicalServerUrl: 'http://home.example.test',
    }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      canonicalServerUrl: 'https://home.example.test?mode=enroll',
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
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      endpoints: [{ kind: 'https', url: 'http://home.example.test' }],
    }).success).toBe(false);
    // The composed Iroh variant keeps the canonical connectivity module's
    // strict/unknown-field rejection inside the outer descriptor union.
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      endpoints: [{ ...IROH_DESCRIPTOR.endpoints[0], unexpected: true }],
    }).success).toBe(false);
    expect(HomeConnectionDescriptorV1Schema.safeParse({
      ...HTTPS_DESCRIPTOR,
      endpoints: [{ ...IROH_DESCRIPTOR.endpoints[0], v: 1 }],
    }).success).toBe(false);
  });

  it('canonically binds credential-bearing Home destinations', () => {
    const descriptor = {
      ...MIXED_DESCRIPTOR,
      revision: 41,
      endpoints: [
        { kind: 'iroh' as const, endpointId: 'd'.repeat(64), relayUrls: ['https://relay-b.example.test'], directAddresses: ['192.0.2.2:443'] },
        { kind: 'https' as const, url: 'https://SECOND.example.test:443/path' },
        { kind: 'iroh' as const, endpointId: 'c'.repeat(64), relayUrls: ['https://relay-a.example.test'], directAddresses: ['192.0.2.1:443'] },
        { kind: 'https' as const, url: 'https://home.example.test/base' },
        { kind: 'iroh' as const, endpointId: 'c'.repeat(64) },
        { kind: 'https' as const, url: 'https://second.example.test/path' },
      ],
    };
    const canonical = createHomeCredentialDestinationV1(descriptor);

    expect(ACCOUNT_DIRECTORY_CREDENTIAL_DESTINATION_DIGEST_DOMAIN_V1)
      .toBe('happier.account-directory.home-login.credential-destination.v1');
    expect(canonical).toEqual({
      v: 1,
      homeServerIdentityId: 'srv_home_mixed',
      canonicalServerUrl: 'https://home.example.test/base',
      applicationEndpointUrls: [
        'https://home.example.test/base',
        'https://second.example.test/path',
      ],
      irohEndpointIds: ['c'.repeat(64), 'd'.repeat(64)],
    });
    expect(HomeCredentialDestinationV1Schema.parse(canonical)).toEqual(canonical);
    expect(HomeCredentialDestinationV1Schema.safeParse({ ...canonical, revision: 41 }).success).toBe(false);
    expect(HomeCredentialDestinationV1Schema.safeParse({
      ...canonical,
      canonicalServerUrl: 'not-a-url',
    }).success).toBe(false);

    expect(isHomeCredentialDestinationAllowedV1(canonical, {
      kind: 'https',
      applicationUrl: 'https://SECOND.example.test:443/path/',
    })).toBe(true);
    expect(isHomeCredentialDestinationAllowedV1(canonical, {
      kind: 'https',
      applicationUrl: 'https://attacker.example.test/path',
    })).toBe(false);
    expect(isHomeCredentialDestinationAllowedV1(canonical, {
      kind: 'iroh',
      endpointId: 'd'.repeat(64),
    })).toBe(true);
    expect(isHomeCredentialDestinationAllowedV1(canonical, {
      kind: 'iroh',
      endpointId: 'e'.repeat(64),
    })).toBe(false);
    expect(HomeCredentialDestinationV1Schema.safeParse({
      ...canonical,
      applicationEndpointUrls: [...canonical.applicationEndpointUrls].reverse(),
    }).success).toBe(false);
    expect(HomeCredentialDestinationV1Schema.safeParse({
      ...canonical,
      irohEndpointIds: [canonical.irohEndpointIds[0], canonical.irohEndpointIds[0]],
    }).success).toBe(false);
    expect(HomeCredentialDestinationV1Schema.safeParse({
      ...canonical,
      applicationEndpointUrls: Array.from(
        { length: 17 },
        (_, index) => `https://destination-${String(index).padStart(2, '0')}.example.test/`,
      ),
    }).success).toBe(false);

    const digest = createHomeCredentialDestinationDigestV1(descriptor);
    expect(digest).toBe('Dp90cbs5GdTQplxyhVptYwLVcumzgBUq-47y7lJyNqw');
    for (const equivalent of [
      { ...descriptor, revision: 42 },
      { ...descriptor, endpoints: [...descriptor.endpoints].reverse() },
      {
        ...descriptor,
        endpoints: descriptor.endpoints.map((endpoint) => endpoint.kind === 'iroh'
          ? { ...endpoint, relayUrls: ['https://changed-relay.example.test'], directAddresses: ['203.0.113.8:443'] }
          : endpoint),
      },
    ]) {
      expect(createHomeCredentialDestinationDigestV1(equivalent)).toBe(digest);
    }

    for (const changed of [
      { ...descriptor, homeServerIdentityId: 'srv_home_other' },
      { ...descriptor, canonicalServerUrl: 'https://auth-other.example.test' },
      {
        ...descriptor,
        endpoints: descriptor.endpoints.map((endpoint, index) => index === 1
          ? { kind: 'https' as const, url: 'https://different.example.test/path' }
          : endpoint),
      },
      {
        ...descriptor,
        endpoints: descriptor.endpoints.map((endpoint, index) => index === 0
          ? { ...endpoint, endpointId: 'e'.repeat(64) }
          : endpoint),
      },
    ]) {
      expect(createHomeCredentialDestinationDigestV1(changed)).not.toBe(digest);
    }
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
      label: plainReadLabel('Personal Home'),
      connectionDescriptor: HTTPS_DESCRIPTOR,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_001,
      preferred: true,
    };
    expect(AccountDirectoryHomeEntryV1Schema.parse(homeEntry)).toEqual(homeEntry);
    expect(AccountDirectoryHomePutRequestV1Schema.parse({
      v: 1,
      label: plainStoredLabel('Personal Home'),
      connectionDescriptor: HTTPS_DESCRIPTOR,
    })).toMatchObject({ label: plainStoredLabel('Personal Home') });
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
    expect(AccountDirectoryHomesResponseV1Schema.safeParse({
      v: 1,
      homes: [homeEntry],
      preferredHomeServerIdentityId: null,
    }).success).toBe(false);
    expect(AccountDirectoryHomesResponseV1Schema.safeParse({
      v: 1,
      homes: [{ ...homeEntry, preferred: false }],
      preferredHomeServerIdentityId: HTTPS_DESCRIPTOR.homeServerIdentityId,
    }).success).toBe(false);
    expect(AccountDirectoryHomePutRequestV1Schema.safeParse({
      v: 1,
      accountId: 'caller-supplied-account',
      label: plainStoredLabel('Personal Home'),
      connectionDescriptor: HTTPS_DESCRIPTOR,
    }).success).toBe(false);
    const publication = {
      v: 2 as const,
      label: plainStoredLabel('Personal Home'),
      minimumOuterRevisionExclusive: 7,
      canonicalServerUrl: 'https://moved-home.example.test',
      endpoints: [{ kind: 'https' as const, url: 'https://moved-home.example.test' }],
    };
    expect(AccountDirectoryHomePutRequestV1Schema.safeParse(publication).success).toBe(false);

    const me = AccountDirectoryMeResponseV1Schema.parse({
      v: 1,
      accountId: 'account-1',
      encryptionMode: 'plain',
      displayName: 'Ada Lovelace',
      avatar: null,
      linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' }],
    });
    expect(me.linkedAuthenticationMethods).toHaveLength(1);
    expect(me.encryptionMode).toBe('plain');
  });

  it('parses directories beyond the former 256-Home product quota', () => {
    const homes = Array.from({ length: 257 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0');
      const homeServerIdentityId = `srv_home_${suffix}`;
      const canonicalServerUrl = `https://home-${suffix}.example.test`;
      return {
        v: 1 as const,
        homeServerIdentityId,
        canonicalServerUrl,
        label: plainReadLabel(`Home ${suffix}`),
        connectionDescriptor: {
          v: 1 as const,
          homeServerIdentityId,
          canonicalServerUrl,
          revision: 1,
          endpoints: [{ kind: 'https' as const, url: canonicalServerUrl }],
        },
        createdAtMs: 1_700_000_000_000 + index,
        updatedAtMs: 1_700_000_000_000 + index,
        preferred: index === 0,
      };
    });
    expect(AccountDirectoryHomesResponseV1Schema.parse({
      v: 1,
      homes,
      preferredHomeServerIdentityId: homes[0]!.homeServerIdentityId,
    }).homes).toHaveLength(257);
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
    // The pinned issuer key must be canonical unpadded base64url — padded or
    // non-canonical encodings are rejected, matching the capability projection.
    expect(AccountDirectoryLinkV1Schema.safeParse({
      ...link,
      issuerSigningPublicKeyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }).success).toBe(false);
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
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      sealedHomeTokenBase64Url: 'A'.repeat(64),
      issuedAtMs: ASSERTION.issuedAtMs,
      expiresAtMs: ASSERTION.expiresAtMs,
    };
    // Authorized redemption is the locked exact-five response shape. Approval is
    // a separate strict outcome; mixed payloads fail closed in the union.
    expect(HomeLoginRedemptionResponseV1Schema.parse(authorized)).toEqual(authorized);
    expect(HomeLoginRedemptionResultV1Schema.parse(authorized)).toEqual(authorized);
    expect(Object.keys(HomeLoginRedemptionResponseV1Schema.parse(authorized)).sort()).toEqual([
      'expiresAtMs',
      'homeServerIdentityId',
      'issuedAtMs',
      'sealedHomeTokenBase64Url',
      'v',
    ]);
    expect(HomeLoginRedemptionResultV1Schema.parse({
      v: 1,
      outcome: 'approval_required',
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      approvalId: 'approval-1',
      deviceLabel: null,
      expiresAtMs: ASSERTION.expiresAtMs,
    })).toMatchObject({ outcome: 'approval_required', approvalId: 'approval-1' });
    expect(HomeLoginRedemptionResultV1Schema.safeParse({
      v: 1,
      outcome: 'approval_required',
      homeServerIdentityId: ASSERTION.audienceHomeServerIdentityId,
      approvalId: 'approval-1',
      deviceLabel: null,
      expiresAtMs: ASSERTION.expiresAtMs,
      sealedHomeTokenBase64Url: authorized.sealedHomeTokenBase64Url,
    }).success).toBe(false);
    // Mixed/unknown authority fields fail closed and success never carries a discriminator or data key.
    expect(HomeLoginRedemptionResponseV1Schema.safeParse({
      ...authorized,
      outcome: 'authorized',
    }).success).toBe(false);
    expect(HomeLoginRedemptionResponseV1Schema.safeParse({
      ...authorized,
      approvalId: 'approval-1',
    }).success).toBe(false);
    expect(HomeLoginRedemptionResponseV1Schema.safeParse({
      ...authorized,
      dataKey: 'must-not-cross-this-boundary',
    }).success).toBe(false);
    expect(HomeLoginRedemptionResultV1Schema.safeParse({
      ...authorized,
      outcome: 'unknown',
    }).success).toBe(false);
  });

  it('rejects assertion lifetime, key, audience, version, and signature shape violations', () => {
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, expiresAtMs: ASSERTION.issuedAtMs + 119_999 }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, expiresAtMs: ASSERTION.issuedAtMs + 300_001 }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, signatureBase64Url: 'A' }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, clientBoxPublicKeyBase64: 'A' }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({
      ...ASSERTION,
      clientBoxPublicKeyBase64: ASSERTION.clientBoxPublicKeyBase64.replace(/=+$/u, ''),
    }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, purpose: 'wrong-purpose' }).success).toBe(false);
    const { credentialDestinationDigestBase64Url: _digest, ...missingDestinationDigest } = ASSERTION;
    expect(HomeLoginAssertionV1Schema.safeParse(missingDestinationDigest).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({
      ...ASSERTION,
      credentialDestinationDigestBase64Url: 'not-a-canonical-sha256-digest',
    }).success).toBe(false);
    expect(HomeLoginAssertionV1Schema.safeParse({ ...ASSERTION, audienceHomeServerIdentityId: 'srv_other' }).success).toBe(true);
  });

  it('uses the one domain-separated, length-delimited assertion signing encoding', () => {
    const bytes = createHomeLoginAssertionSigningBytesV1(ASSERTION);
    const bytesAsHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1).toBe('happier.account-directory.home-login.v1');
    expect(bytesAsHex).toBe('00000027686170706965722e6163636f756e742d6469726563746f72792e686f6d652d6c6f67696e2e7631000000013100000012686170706965722e686f6d652d6c6f67696e000000137372765f6163636f756e745f73657276696365000000116163636f756e742d7375626a6563742d310000000e7372765f686f6d655f68747470730000002b414141414141414141414141414141414141414141414141414141414141414141414141414141414141410000002c414141414141414141414141414141414141414141414141414141414141414141414141414141414141413d0000000d313730303030303030303030300000000d313730303030303138303030300000004030313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566');
  });

  it('exposes typed route errors without leaking credentials', () => {
    expect(ACCOUNT_DIRECTORY_ERROR_CODES_V1).toMatchObject({
      invalidToken: 'invalid_token',
      invalidAssertionSignature: 'invalid_assertion_signature',
      descriptorRevisionConflict: 'descriptor_revision_conflict',
      approvalRejected: 'approval_rejected',
      approvalExpired: 'approval_expired',
      approvalInvalid: 'approval_invalid',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'invalid_assertion_signature' })).toEqual({
      error: 'invalid_assertion_signature',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'rate_limited' })).toEqual({
      error: 'rate_limited',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'invalid_token' })).toEqual({
      error: 'invalid_token',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'approval_rejected' })).toEqual({
      error: 'approval_rejected',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'approval_expired' })).toEqual({
      error: 'approval_expired',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.parse({ error: 'approval_invalid' })).toEqual({
      error: 'approval_invalid',
    });
    expect(AccountDirectoryRouteErrorResponseV1Schema.safeParse({ error: 'invalid_token', token: 'secret' }).success).toBe(false);
  });
});
