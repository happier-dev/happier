import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
  ACCOUNT_API_TOKEN_INTROSPECTION_MAX_BODY_BYTES_V1,
  AccountApiTokenSummaryV1Schema,
  AccountApiTokenIntrospectionRequestV1Schema,
  AccountApiTokenIntrospectionSubjectFailureV1Schema,
  AccountApiTokenIntrospectionSuccessV1Schema,
  parseAccountApiTokenBearerV1,
} from './accountApiTokens.js';

const CREDENTIAL_ID = '2c67deea-5ae7-4706-9ad6-b5b992df1cba';
const PAT = `hap_v1_${CREDENTIAL_ID}_${'A'.repeat(43)}`;

describe('auth/accountApiTokens PAT introspection', () => {
  it('uses a truthful non-secret display prefix from the minted bearer format', () => {
    expect(AccountApiTokenSummaryV1Schema.parse({
      tokenId: CREDENTIAL_ID,
      label: 'Build automation',
      displayPrefix: 'hap_v1_2c67deea',
      createdAt: '2026-08-22T12:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
    }).displayPrefix).toBe('hap_v1_2c67deea');

    expect(AccountApiTokenSummaryV1Schema.safeParse({
      tokenId: CREDENTIAL_ID,
      label: 'Build automation',
      displayPrefix: 'hap_2c67deea',
      createdAt: '2026-08-22T12:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
    }).success).toBe(false);
  });

  it('owns the exact bearer grammar minted by the Account server', () => {
    expect(parseAccountApiTokenBearerV1(PAT)).toEqual({
      tokenId: CREDENTIAL_ID,
      secret: 'A'.repeat(43),
    });
    expect(parseAccountApiTokenBearerV1(
      `hap_v1_2c67deea-5ae7-1706-9ad6-b5b992df1cba_${'A'.repeat(43)}`,
    )).toBeNull();
    expect(parseAccountApiTokenBearerV1(
      `hap_v1_2c67deea-5ae7-4706-1ad6-b5b992df1cba_${'A'.repeat(43)}`,
    )).toBeNull();
    expect(parseAccountApiTokenBearerV1(`${PAT}extra`)).toBeNull();
  });

  it('owns the strict introspection path and request envelope', () => {
    expect(ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1).toBe(
      '/v1/auth/api-tokens/introspect',
    );
    expect(ACCOUNT_API_TOKEN_INTROSPECTION_MAX_BODY_BYTES_V1).toBe(1_024);
    expect(
      AccountApiTokenIntrospectionRequestV1Schema.parse({ token: PAT }),
    ).toEqual({ token: PAT });
    expect(
      AccountApiTokenIntrospectionRequestV1Schema.safeParse({
        token: PAT,
        accountId: 'caller-selected-account',
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionRequestV1Schema.safeParse({ token: 'pat' })
        .success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionRequestV1Schema.safeParse({
        token: `hap_v1_${CREDENTIAL_ID}_${'A'.repeat(4_300)}`,
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionRequestV1Schema.safeParse({ token: 42 })
        .success,
    ).toBe(false);
  });

  it('accepts only a strict Account-bound principal with a UUID credential id', () => {
    const principal = {
      accountId: 'account-a',
      principalId: 'account-a',
      credentialId: CREDENTIAL_ID,
      expiresAt: '2030-08-22T12:01:00.000Z',
      authority: 'account_automation' as const,
    };

    expect(AccountApiTokenIntrospectionSuccessV1Schema.parse(principal)).toEqual(
      principal,
    );
    expect(
      AccountApiTokenIntrospectionSuccessV1Schema.safeParse({
        ...principal,
        principalId: 'different-account',
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionSuccessV1Schema.safeParse({
        ...principal,
        credentialId: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionSuccessV1Schema.safeParse({
        ...principal,
        accountId: '',
        principalId: '',
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionSuccessV1Schema.safeParse({
        ...principal,
        unexpectedAuthority: true,
      }).success,
    ).toBe(false);
  });

  it('keeps authenticated subject rejection distinct from connection authentication failure', () => {
    expect(
      AccountApiTokenIntrospectionSubjectFailureV1Schema.parse({
        error: 'invalid_token',
      }),
    ).toEqual({ error: 'invalid_token' });
    expect(
      AccountApiTokenIntrospectionSubjectFailureV1Schema.safeParse({
        error: 'authentication_failed',
      }).success,
    ).toBe(false);
    expect(
      AccountApiTokenIntrospectionSubjectFailureV1Schema.safeParse({
        error: 'invalid_token',
        detail: 'credential rejected',
      }).success,
    ).toBe(false);
  });
});
