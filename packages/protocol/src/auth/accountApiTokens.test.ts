import { describe, expect, it } from 'vitest';
import * as tokens from './accountApiTokens.js';
import { encodeBase64 } from '../crypto/base64.js';
import { API_TOKEN_FULL_GRANT_V1 } from './apiTokenGrant.js';

import {
  ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
  ACCOUNT_API_TOKEN_INTROSPECTION_MAX_BODY_BYTES_V1,
  AccountApiTokenSummaryV1Schema,
  AccountApiTokenIntrospectionRequestV1Schema,
  AccountApiTokenIntrospectionSubjectFailureV1Schema,
  AccountApiTokenIntrospectionConnectionFailureV1Schema,
  AccountApiTokenIntrospectionSuccessV1Schema,
  parseAccountApiTokenBearerV1,
} from './accountApiTokens.js';

const CREDENTIAL_ID = '2c67deea-5ae7-4706-9ad6-b5b992df1cba';
const PAT = `hap_v1_${CREDENTIAL_ID}_${'A'.repeat(43)}`;

function plainStoredLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipients: [] };
}

function plainReadLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipientEnvelope: null };
}

describe('API token encryption credentials', () => {
  it('carries private labels as stored writes and reader-only projections', () => {
    const stored = { content: { t: 'plain' as const, v: 'Staging CI' }, recipients: [] };
    const read = { content: stored.content, recipientEnvelope: null };
    const input = { tokenId: CREDENTIAL_ID, label: stored };
    const summary = {
      tokenId: CREDENTIAL_ID,
      label: read,
      displayPrefix: 'hap_v1_2c67deea',
      createdAt: '2026-08-22T12:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      hasEncryptionAccess: false,
      hasUnattendedTeamAccess: false,
      grant: API_TOKEN_FULL_GRANT_V1,
      parentTokenId: null,
      activeChildCount: 0,
      embedConfig: null,
    };

    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse(input).success).toBe(true);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, label: 'Staging CI' }).success).toBe(false);
    expect(tokens.AccountApiTokenSummaryV1Schema.safeParse(summary).success).toBe(true);
    expect(tokens.AccountApiTokenSummaryV1Schema.safeParse({ ...summary, label: stored }).success).toBe(false);
  });

  it('admits deployment Automatic or Ask intent without accepting caller-authored consent', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: ['staging'] },
    };
    const deployment = { serverId: 'srv_home', environmentId: 'staging', deployApproval: 'automatic' };
    const create = { tokenId: CREDENTIAL_ID, label: plainStoredLabel('Staging CI'), grant, deployment };
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse(create).success).toBe(true);
    expect(tokens.AccountApiTokensUpdateActionInputV1Schema.safeParse({ tokenId: CREDENTIAL_ID,
      deployment: { ...deployment, deployApproval: 'ask' },
    }).success).toBe(true);
    for (const invalid of [
      { ...create, deployment: { ...deployment, approvedBy: { accountId: 'person' } } },
      { ...create, deployment: { ...deployment, approval: { steps: [] } } },
      { ...create, deployment: { ...deployment, sha: 'a'.repeat(40) } },
      { ...create, deploymentApproval: { input: { serverId: 'srv_home', environmentId: 'staging' } } },
      { ...create, grant: { ...grant, deploymentApproval: {
        input: { serverId: 'srv_home', environmentId: 'staging' },
      } } },
    ]) expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse(invalid).success).toBe(false);
  });
  it('carries Automatic only in a narrow Environment grant, with no private consent transport', () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: ['staging'] },
      deployApproval: 'automatic',
    };
    const create = { tokenId: CREDENTIAL_ID, label: plainStoredLabel('Staging CI'), grant };
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.parse(create).grant).toEqual(grant);
    for (const changed of [
      { ...grant, actions: null }, { ...grant, approve: true },
      { ...grant, targets: null },
      { ...grant, targets: { ...grant.targets, environments: ['staging', 'production'] } },
      { ...grant, targets: { ...grant.targets, machines: ['machine'] } },
    ]) expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...create, grant: changed }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateHttpInputV1Schema.safeParse({ ...create, deploymentConsent: null }).success).toBe(false);
    expect(tokens.AccountApiTokensUpdateHttpInputV1Schema.safeParse({ tokenId: CREDENTIAL_ID,
      deployment: { serverId: 'srv_home', environmentId: 'staging', deployApproval: 'ask' },
      deploymentConsent: null,
    }).success).toBe(false);
  });
  it('requests delegated summaries explicitly without accepting an Account selector or false completeness', () => {
    expect(tokens.AccountApiTokensListActionInputV1Schema.parse({})).toEqual({});
    expect(tokens.AccountApiTokensListActionInputV1Schema.parse({ includeChildren: true })).toEqual({ includeChildren: true });
    for (const input of [{ includeChildren: false }, { includeChildren: true, accountId: 'foreign' }]) {
      expect(tokens.AccountApiTokensListActionInputV1Schema.safeParse(input).success).toBe(false);
    }
  });
  it('admits deliberate unattended Team reapproval without caller-authored evidence or bearer disclosure', () => {
    const input = { tokenId: CREDENTIAL_ID, authorizeUnattendedTeamAccess: true };
    expect(tokens.AccountApiTokensUpdateActionInputV1Schema.parse(input)).toEqual(input);
    expect(tokens.AccountApiTokensUpdateActionInputV1Schema.safeParse({ tokenId: CREDENTIAL_ID }).success).toBe(false);
    expect(tokens.AccountApiTokensUpdateActionInputV1Schema.safeParse({ ...input, authorizeUnattendedTeamAccess: false }).success).toBe(false);
    expect(tokens.AccountApiTokensUpdateActionInputV1Schema.safeParse({
      ...input, authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
    }).success).toBe(false);
  });
  it('requires persisted Account mode on scoped self without inferring it from credential material', () => {
    const self = { accountId: 'a', credentialId: CREDENTIAL_ID, parentTokenId: null,
      expiresAt: null, grant: API_TOKEN_FULL_GRANT_V1, embedConfig: null };
    expect(tokens.AccountApiTokenSelfV1Schema.safeParse(self).success).toBe(false);
    expect(tokens.AccountApiTokenSelfV1Schema.safeParse({ ...self, accountEncryptionMode: 'plain' }).success).toBe(true);
    expect(tokens.AccountApiTokenSelfV1Schema.safeParse({ ...self, accountEncryptionMode: 'e2ee' }).success).toBe(true);
  });
  const payload = {
    bearer: PAT,
    wrappingSecret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
    serverIdentityId: 'srv_home',
    accountId: 'account-a',
    contentPublicKey: encodeBase64(new Uint8Array(32).fill(9)),
  };
  const encode = (value: unknown) => `hapc_v1_${encodeBase64(new TextEncoder().encode(JSON.stringify(value)), 'base64url')}`;

  it('round trips a closed local credential without making it a bearer', () => {
    const credential = tokens.formatAccountApiTokenCredentialV1(payload);
    expect(tokens.parseAccountApiTokenCredentialV1(credential)).toEqual(payload);
    expect(parseAccountApiTokenBearerV1(credential)).toBeNull();
    for (const invalid of [
      { ...payload, extra: true },
      { ...payload, wrappingSecret: `${payload.wrappingSecret}=` },
      { ...payload, contentPublicKey: payload.contentPublicKey.slice(0, -1) },
      { ...payload, bearer: `${PAT.slice(0, -1)}B` },
      { ...payload, serverIdentityId: 'https://home.example' },
    ]) expect(tokens.parseAccountApiTokenCredentialV1(encode(invalid))).toBeNull();
    expect(tokens.parseAccountApiTokenCredentialV1(`${credential}=`)).toBeNull();
    expect(tokens.parseAccountApiTokenCredentialV1(credential.replace('v1', 'v2'))).toBeNull();
  });

  it('admits only atomic UUIDv4 creation and fixed-size wrapping records', () => {
    const input = {
      tokenId: CREDENTIAL_ID,
      label: plainStoredLabel('SDK'),
      authorizeUnattendedTeamAccess: true,
      encryption: {
        access: { v: 1, serverIdentityId: payload.serverIdentityId,
          contentPublicKey: payload.contentPublicKey,
          wrappedContentPrivateKey: encodeBase64(new Uint8Array(72), 'base64url') },
      },
    };
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.parse(input)).toEqual(input);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, wrappingSecret: payload.wrappingSecret }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({
      ...input,
      authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }],
    }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ label: input.label }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, tokenId: CREDENTIAL_ID.replace('4706', '1706') }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, encryption: { tokenId: CREDENTIAL_ID, access: input.encryption.access } }).success).toBe(false);
    expect(tokens.AccountApiTokensCreateActionInputV1Schema.safeParse({ ...input, encryption: { ...input.encryption, access: { ...input.encryption.access, wrappedContentPrivateKey: 'AA' } } }).success).toBe(false);
  });

  it('uses one strict list projection with required capability metadata', () => {
    const summary = {
      tokenId: CREDENTIAL_ID,
      label: plainReadLabel('SDK'),
      displayPrefix: 'hap_v1_2c67deea',
      createdAt: '2026-08-22T12:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      hasEncryptionAccess: true,
      hasUnattendedTeamAccess: true,
      grant: API_TOKEN_FULL_GRANT_V1,
      parentTokenId: null,
      activeChildCount: 0,
      embedConfig: null,
    };
    expect(tokens.AccountApiTokensListActionInputV1Schema.parse({})).toEqual({});
    const observation = tokens.projectAccountApiTokenCreationObservation({ apiToken: summary, token: PAT });
    expect(tokens.projectAccountApiTokenCreationObservation(observation)).toEqual({ apiToken: summary });
    expect(tokens.AccountApiTokensListActionInputV1Schema.safeParse({ includeEncryptionAccess: true }).success).toBe(false);
    expect(tokens.AccountApiTokensListActionOutputV1Schema.parse({ tokens: [summary] })).toEqual({ tokens: [summary] });
    expect(tokens.AccountApiTokensListActionOutputV1Schema.safeParse({ tokens: [{ ...summary, hasEncryptionAccess: undefined }] }).success).toBe(false);
    expect(tokens.AccountApiTokensListActionOutputV1Schema.safeParse({
      tokens: [{ ...summary, hasUnattendedTeamAccess: undefined }],
    }).success).toBe(false);
    expect(tokens.AccountApiTokensListActionOutputV1Schema.safeParse({ v: 2, tokens: [summary] }).success).toBe(false);
  });

  it('keeps one strict current management error union', () => {
    for (const error of [
      'invalid_request', 'present_user_required', 'account-disabled',
      'api_token_required', 'api_token_id_conflict',
      'api_token_encryption_unavailable', 'api_token_encryption_stale',
      'api_token_encryption_not_ready',
      'credential_authentication_evidence_limit',
      'credential_authentication_evidence_unavailable',
    ]) {
      expect(tokens.AccountApiTokensServerErrorV1Schema.parse({ error })).toEqual({ error });
    }
    for (const error of [
      'database_transaction_conflict_exhausted',
      'database_connection_unavailable',
      'database_transaction_timeout',
    ]) {
      expect(tokens.AccountApiTokensServerErrorV1Schema.parse({ error, statusCode: 503 }))
        .toEqual({ error, statusCode: 503 });
      expect(tokens.AccountApiTokensServerErrorV1Schema.safeParse({ error }).success).toBe(false);
    }
    expect(tokens.AccountApiTokensServerErrorV1Schema.safeParse({ error: 'account_disabled' }).success).toBe(false);
    expect(tokens.AccountApiTokensServerErrorV1Schema.safeParse({ error: 'invalid_request', detail: 'secret' }).success).toBe(false);
    expect(tokens.AccountApiTokensServerErrorV1Schema.safeParse({ error: 'invalid_request', statusCode: 503 }).success).toBe(false);
  });
});

describe('auth/accountApiTokens PAT introspection', () => {
  it('uses a truthful non-secret display prefix from the minted bearer format', () => {
    expect(AccountApiTokenSummaryV1Schema.parse({
      tokenId: CREDENTIAL_ID,
      label: plainReadLabel('Build automation'),
      displayPrefix: 'hap_v1_2c67deea',
      grant: API_TOKEN_FULL_GRANT_V1,
      parentTokenId: null,
      activeChildCount: 0,
      embedConfig: null,
      createdAt: '2026-08-22T12:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      hasEncryptionAccess: false,
      hasUnattendedTeamAccess: false,
    }).displayPrefix).toBe('hap_v1_2c67deea');

    expect(AccountApiTokenSummaryV1Schema.safeParse({
      tokenId: CREDENTIAL_ID,
      label: plainReadLabel('Build automation'),
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
      grant: API_TOKEN_FULL_GRANT_V1,
      parentTokenId: null,
      embedConfig: null,
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
      AccountApiTokenIntrospectionConnectionFailureV1Schema.safeParse({
        error: 'authentication_failed',
      }).success,
    ).toBe(true);
    expect(
      AccountApiTokenIntrospectionConnectionFailureV1Schema.safeParse({
        error: 'invalid_token',
      }).success,
    ).toBe(false);
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
