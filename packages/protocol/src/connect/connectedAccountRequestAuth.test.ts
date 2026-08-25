import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  ConnectedAccountRequestAuthErrorResponseV1Schema,
  ConnectedAccountRequestAuthFailureSuccessResponseV1Schema,
  ConnectedAccountRequestAuthLookupSuccessResponseV1Schema,
  getConnectedAccountRequestAuthErrorHttpStatusV1,
  ConnectedAccountAuthFailureRequestV1Schema,
  ConnectedAccountRequestAuthMaterializationV1Schema,
  ConnectedAccountQuotaFailureRequestV1Schema,
  ConnectedAccountRequestAuthLookupRequestV1Schema,
  ConnectedAccountRequestAuthUsesV1Schema,
  OAuthBearerLeaseV1Schema,
  RequestAuthFailureOutcomeV1Schema,
} from './connectedAccountRequestAuth.js';

const requestAuthHttpVectors = z.object({
  v: z.literal(1),
  paths: z.object({
    lookup: z.string(),
    authFailure: z.string(),
    quotaFailure: z.string(),
  }).strict(),
  responses: z.array(z.object({
    name: z.string(),
    status: z.number().int(),
    body: z.unknown(),
  }).strict()),
}).strict().parse(JSON.parse(readFileSync(
  new URL('./connectedAccountRequestAuthHttpV1.vectors.json', import.meta.url),
  'utf8',
)));

const service = {
  pluginId: 'happier.connected-account.test',
  localId: 'subscription',
} as const;

const purpose = {
  consumer: {
    pluginId: 'happier.agent.opencode',
    localId: 'opencode',
  },
  purpose: 'model-openai',
} as const;

const credentialContext = {
  account: { service, accountId: 'work' },
  group: { groupId: 'fallbacks', generation: 7 },
  credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
  failingAccessTokenFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as const;

describe('private connected-account request-auth wire', () => {
  it('owns strict HTTP envelopes, status mapping, and Go conformance vectors', () => {
    expect(requestAuthHttpVectors.paths).toEqual({
      lookup: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
      authFailure: CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
      quotaFailure: CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
    });

    for (const vector of requestAuthHttpVectors.responses) {
      if (vector.status === 200) {
        expect(ConnectedAccountRequestAuthFailureSuccessResponseV1Schema.parse(vector.body))
          .toEqual(vector.body);
        continue;
      }
      const error = ConnectedAccountRequestAuthErrorResponseV1Schema.parse(vector.body);
      expect(getConnectedAccountRequestAuthErrorHttpStatusV1(error.error.code))
        .toBe(vector.status);
    }

    expect(ConnectedAccountRequestAuthErrorResponseV1Schema.safeParse({
      ok: false,
      error: { code: 'fixture_error' },
    }).success).toBe(false);
    expect(ConnectedAccountRequestAuthErrorResponseV1Schema.safeParse({
      ok: false,
      error: { code: 'request_auth_not_active', message: 'nope' },
    }).success).toBe(false);
    expect(ConnectedAccountRequestAuthFailureSuccessResponseV1Schema.safeParse({
      ok: true,
      value: { status: 'current_unchanged' },
      unexpected: true,
    }).success).toBe(false);
  });

  it('accepts only an exact canonical HTTPS origin and lowercase unique requested headers', () => {
    expect(ConnectedAccountRequestAuthMaterializationV1Schema.parse({
      kind: 'httpHeaders',
      origin: 'https://chatgpt.com',
      headerNames: ['authorization', 'chatgpt-account-id'],
    })).toEqual({
      kind: 'httpHeaders',
      origin: 'https://chatgpt.com',
      headerNames: ['authorization', 'chatgpt-account-id'],
    });

    for (const origin of [
      'http://chatgpt.com',
      'https://chatgpt.com/',
      'https://chatgpt.com/backend-api',
      'https://chatgpt.com?source=test',
      'https://chatgpt.com#fragment',
      'https://user@chatgpt.com',
      'https://CHATGPT.com',
      'https://chatgpt.com:443',
    ]) {
      expect(ConnectedAccountRequestAuthMaterializationV1Schema.safeParse({
        kind: 'httpHeaders',
        origin,
        headerNames: ['authorization'],
      }).success).toBe(false);
    }
    for (const headerNames of [
      [],
      ['chatgpt-account-id'],
      ['Authorization'],
      ['authorization', 'Chatgpt-Account-Id'],
      ['authorization', 'x-account', 'x-account'],
    ]) {
      expect(ConnectedAccountRequestAuthMaterializationV1Schema.safeParse({
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames,
      }).success).toBe(false);
    }
  });

  it('rejects duplicate request-auth purpose descriptors', () => {
    const use = {
      purpose: 'model-request',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
    } as const;
    expect(ConnectedAccountRequestAuthUsesV1Schema.parse([use])).toEqual([use]);
    expect(ConnectedAccountRequestAuthUsesV1Schema.safeParse([use, use]).success)
      .toBe(false);
  });

  it('looks up one qualified purpose and exposes no generic force-refresh switch', () => {
    expect(ConnectedAccountRequestAuthLookupRequestV1Schema.parse({ purpose })).toEqual({ purpose });
    expect(ConnectedAccountRequestAuthLookupRequestV1Schema.safeParse({
      purpose,
      forceRefresh: true,
    }).success).toBe(false);
  });

  it('accepts a minimal bearer lease and rejects competing Authorization header authority', () => {
    const lease = {
      accessToken: 'secret',
      requiredHeaders: {
        'chatgpt-account-id': 'acct_123',
      },
      expiresAt: 10_000,
      credentialContext,
    } as const;
    expect(OAuthBearerLeaseV1Schema.parse(lease)).toEqual(lease);
    expect(ConnectedAccountRequestAuthLookupSuccessResponseV1Schema.parse({
      ok: true,
      value: lease,
    })).toEqual({ ok: true, value: lease });
    expect(ConnectedAccountRequestAuthLookupSuccessResponseV1Schema.safeParse({
      ok: true,
      value: { ...lease, unexpected: true },
    }).success).toBe(false);

    expect(OAuthBearerLeaseV1Schema.safeParse({
      accessToken: 'secret',
      requiredHeaders: { Authorization: 'Bearer competing-secret' },
      credentialContext,
    }).success).toBe(false);
    expect(OAuthBearerLeaseV1Schema.safeParse({
      accessToken: 'secret',
      requiredHeaders: {
        'X-Account': 'one',
        'x-account': 'two',
      },
      credentialContext,
    }).success).toBe(false);
  });

  it('keeps credential context bounded and contains no request/acquisition lineage', () => {
    expect(OAuthBearerLeaseV1Schema.safeParse({
      accessToken: 'secret',
      credentialContext: {
        ...credentialContext,
        requestId: 'request-1',
      },
    }).success).toBe(false);
  });

  it('separates exact authentication and quota evidence operations', () => {
    const authentication = {
      credentialContext,
      normalizedFailure: {
        class: 'authentication',
        evidence: {
          httpStatus: 401,
          providerCode: 'invalid_token',
          limitCategory: 'auth_invalid',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        },
      },
    } as const;
    const quota = {
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 429,
          providerCode: 'rate_limit',
          retryAfterMs: 1_000,
          limitCategory: 'rate_limit',
          quotaScope: 'account',
          evidenceSource: { kind: 'structured' },
        },
      },
    } as const;

    expect(ConnectedAccountAuthFailureRequestV1Schema.safeParse(authentication).success).toBe(true);
    expect(ConnectedAccountAuthFailureRequestV1Schema.safeParse(quota).success).toBe(false);
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse(quota).success).toBe(true);
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse(authentication).success).toBe(false);
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      ...quota,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          ...quota.normalizedFailure.evidence,
          limitCategory: 'auth_invalid',
        },
      },
    }).success).toBe(false);
  });

  it('requires explicit canonical category, scope, and bounded provenance', () => {
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 529,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.81.0',
            provider: 'anthropic',
            signatureId: 'anthropic-sdk-529-overloaded-v1',
          },
        },
      },
    }).success).toBe(true);

    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 503,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.82.1',
            provider: 'anthropic',
            signatureId: 'anthropic-sdk-503-api-error-v1',
          },
        },
      },
    }).success).toBe(true);

    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 503,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.82.0',
            provider: 'anthropic',
            signatureId: 'anthropic-sdk-503-api-error-v1',
          },
        },
      },
    }).success).toBe(true);

    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 429,
          limitCategory: 'rate_limit',
          evidenceSource: { kind: 'structured' },
        },
      },
    }).success).toBe(false);
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'opencode',
            producerVersion: '1',
            provider: 'openai',
            signatureId: 'forged',
          },
        },
      },
    }).success).toBe(false);
  });

  it.each([
    {
      label: 'unsupported producer version',
      evidence: {
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.83.0',
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-529-overloaded-v1',
        },
      },
    },
    {
      label: 'case-drifted provider',
      evidence: {
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'Anthropic',
          signatureId: 'anthropic-sdk-529-overloaded-v1',
        },
      },
    },
    {
      label: 'unknown signature',
      evidence: {
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'anthropic',
          signatureId: 'anthropic-overloaded-error-v1',
        },
      },
    },
    {
      label: 'signature from another provider',
      evidence: {
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'anthropic',
          signatureId: 'openai-codex-chatgpt-usage-limit-v1',
        },
      },
    },
    {
      label: 'category inconsistent with signature',
      evidence: {
        limitCategory: 'usage_limit',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-529-overloaded-v1',
        },
      },
    },
    {
      label: 'scope inconsistent with signature',
      evidence: {
        limitCategory: 'capacity',
        quotaScope: 'account',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-529-overloaded-v1',
        },
      },
    },
    {
      label: 'status inconsistent with signature',
      evidence: {
        httpStatus: 429,
        limitCategory: 'capacity',
        quotaScope: 'unknown',
        evidenceSource: {
          kind: 'pinnedProviderTerminal',
          producer: 'pi',
          producerVersion: '0.82.0',
          provider: 'anthropic',
          signatureId: 'anthropic-sdk-529-overloaded-v1',
        },
      },
    },
  ])('rejects $label instead of accepting a free-form pinned provenance bag', ({ evidence }) => {
    expect(ConnectedAccountQuotaFailureRequestV1Schema.safeParse({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence,
      },
    }).success).toBe(false);
  });

  it('returns currentness/recovery state but never replay authorization', () => {
    expect(RequestAuthFailureOutcomeV1Schema.parse({ status: 'current_changed' }))
      .toEqual({ status: 'current_changed' });
    expect(RequestAuthFailureOutcomeV1Schema.safeParse({
      status: 'current_changed',
      retry: true,
    }).success).toBe(false);
  });
});
