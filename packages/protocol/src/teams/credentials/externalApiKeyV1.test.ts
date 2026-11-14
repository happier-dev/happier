import { describe, expect, it } from 'vitest';

import {
  TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1,
  TeamCredentialExternalApiKeyCreateInputV1Schema,
  TeamCredentialExternalApiKeyAuthorizeInputV1Schema,
  TeamCredentialExternalApiKeyAuthorizeOutputV1Schema,
  TeamCredentialExternalApiKeyCreateOutputV1Schema,
  TeamCredentialExternalApiKeyListOutputV1Schema,
  TeamCredentialExternalApiKeyRevokeAllInputV1Schema,
  TeamCredentialExternalApiKeyRevokeAllOutputV1Schema,
  TeamCredentialExternalApiKeyRevokeInputV1Schema,
  TeamCredentialExternalApiKeyRevokeOutputV1Schema,
  TeamCredentialExternalApiKeySummaryV1Schema,
  formatTeamCredentialExternalApiKeyV1,
  parseTeamCredentialExternalApiKeyV1,
} from './externalApiKeyV1.js';

const keyId = '550e8400-e29b-41d4-a716-446655440000';
const secret = 'A'.repeat(43);
const bearer = `${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_${keyId}_${secret}`;
const storedLabel = { content: { t: 'plain' as const, v: 'CI runner' }, recipients: [] };
const readLabel = { content: { t: 'plain' as const, v: 'CI runner' }, recipientEnvelope: null };
const summary = {
  keyId,
  resourceId: 'resource-1',
  teamMembershipId: 'membership-1',
  label: readLabel,
  displayPrefix: `hapek_v1_${keyId.slice(0, 8)}`,
  createdAt: '2026-09-07T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  authenticationStatus: 'satisfied',
  canAuthorize: true,
};

describe('Team credential external API key v1', () => {
  it('accepts the closed bearer and exposes only its selector and secret to the verifier', () => {
    expect(TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1).toBe('hapek_v1');
    expect(parseTeamCredentialExternalApiKeyV1(bearer)).toEqual({ keyId, secret });
    expect(formatTeamCredentialExternalApiKeyV1({ keyId, secret })).toBe(bearer);
    expect(() => formatTeamCredentialExternalApiKeyV1({ keyId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', secret })).toThrow();
    expect(() => parseTeamCredentialExternalApiKeyV1(`hap_v1_${keyId}_${secret}`)).toThrow();
    expect(() => parseTeamCredentialExternalApiKeyV1(`${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_${keyId}_${'!'.repeat(43)}`)).toThrow();
    expect(() => parseTeamCredentialExternalApiKeyV1(`${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_${keyId}_${secret}_extra`)).toThrow();
  });

  it('round-trips an opaque Base64URL secret containing delimiters', () => {
    const opaqueSecret = '_-A'.repeat(14) + '_';
    const opaqueBearer = formatTeamCredentialExternalApiKeyV1({ keyId, secret: opaqueSecret });

    expect(opaqueSecret).toHaveLength(43);
    expect(parseTeamCredentialExternalApiKeyV1(opaqueBearer)).toEqual({ keyId, secret: opaqueSecret });
  });

  it('keeps lifecycle inputs and outputs resource and immutable membership scoped', () => {
    expect(TeamCredentialExternalApiKeyCreateInputV1Schema.parse({
      resourceId: 'resource-1', teamMembershipId: 'membership-1', keyId, label: storedLabel, expiresAt: null,
    })).toEqual({ resourceId: 'resource-1', teamMembershipId: 'membership-1', keyId, label: storedLabel, expiresAt: null });
    expect(TeamCredentialExternalApiKeySummaryV1Schema.parse(summary)).toEqual(summary);
    expect(TeamCredentialExternalApiKeyCreateOutputV1Schema.parse({ token: bearer, key: summary }).key).toEqual(summary);
    expect(TeamCredentialExternalApiKeyListOutputV1Schema.parse({ keys: [summary] }).keys).toHaveLength(1);
    expect(TeamCredentialExternalApiKeyRevokeInputV1Schema.parse({ resourceId: 'resource-1', keyId })).toEqual({ resourceId: 'resource-1', keyId });
    expect(TeamCredentialExternalApiKeyRevokeOutputV1Schema.parse({ keyId, revoked: true })).toEqual({ keyId, revoked: true });
    expect(TeamCredentialExternalApiKeyRevokeAllInputV1Schema.parse({ resourceId: 'resource-1' })).toEqual({ resourceId: 'resource-1' });
    expect(TeamCredentialExternalApiKeyRevokeAllOutputV1Schema.parse({ resourceId: 'resource-1', revokedCount: 2 })).toEqual({ resourceId: 'resource-1', revokedCount: 2 });
  });

  it('rejects secret material and unknown fields in public projections', () => {
    expect(TeamCredentialExternalApiKeyAuthorizeInputV1Schema.parse({ resourceId: 'resource-1', keyId }))
      .toEqual({ resourceId: 'resource-1', keyId });
    expect(TeamCredentialExternalApiKeyAuthorizeInputV1Schema.safeParse({
      resourceId: 'resource-1', keyId, authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
    }).success).toBe(false);
    expect(TeamCredentialExternalApiKeyAuthorizeOutputV1Schema.safeParse({ key: summary, token: bearer }).success).toBe(false);
    expect(TeamCredentialExternalApiKeySummaryV1Schema.safeParse({ ...summary, secretDigest: 'digest' }).success).toBe(false);
    expect(TeamCredentialExternalApiKeySummaryV1Schema.safeParse({ ...summary, token: bearer }).success).toBe(false);
    expect(TeamCredentialExternalApiKeyCreateInputV1Schema.safeParse({
      resourceId: 'resource-1', teamMembershipId: 'membership-1', keyId, label: storedLabel, unexpected: true,
    }).success).toBe(false);
    expect(TeamCredentialExternalApiKeyCreateInputV1Schema.safeParse({
      resourceId: 'resource-1', teamMembershipId: 'membership-1', keyId, label: 'CI runner',
    }).success).toBe(false);
  });
});
