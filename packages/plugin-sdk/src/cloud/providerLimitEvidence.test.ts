import { describe, expect, it } from 'vitest';

import {
  classifyProviderLimitEvidence,
  PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
} from './providerLimitEvidence.js';

describe('provider limit evidence classification', () => {
  it('does not promote raw native terminal text into trusted structured evidence', () => {
    expect(Reflect.apply(classifyProviderLimitEvidence, null, [{
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'error',
        content: [],
        errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      },
    }, {
      kind: 'piTerminalProviderError',
      producerVersion: '0.82.0',
      provider: 'anthropic',
    }])).toMatchObject({ category: 'rate_limit', confidence: 'diagnostic' });
  });
  it('classifies nested provider capacity payloads and Error instances through one SDK owner', () => {
    expect(classifyProviderLimitEvidence({
      turn: {
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'other',
        },
      },
    })).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('Selected model is at capacity. Please try a different model.'),
    )).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('The service is currently experiencing high demand. Please try again later.'),
    )).toMatchObject({
      category: 'capacity',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence(
      new Error('Internal Server Error'),
    )).toMatchObject({
      category: 'unknown',
      confidence: 'diagnostic',
    });
  });

  it('preserves structured status and provider-code classifications', () => {
    expect(classifyProviderLimitEvidence({ error: { data: { status: 429 } } })).toEqual({
      category: 'rate_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', httpStatus: 429 },
    });
    expect(classifyProviderLimitEvidence({ code: 'usage_limit_reached' })).toEqual({
      category: 'usage_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'usage_limit_reached' },
    });
    expect(classifyProviderLimitEvidence({ code: 'insufficient_quota' })).toEqual({
      category: 'usage_limit',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'insufficient_quota' },
    });
    for (const [providerCode, category] of [
      ['account_disabled', 'disabled'],
      ['not_entitled', 'plan_invalid'],
      ['invalid_request_error', 'validation_failed'],
    ] as const) {
      expect(classifyProviderLimitEvidence({ code: providerCode })).toEqual({
        category,
        confidence: 'high',
        quotaScope: 'unknown',
        provenance: { kind: 'structured', providerCode },
      });
    }
    expect(classifyProviderLimitEvidence({ message: 'account disabled' })).toMatchObject({
      category: 'disabled',
      confidence: 'diagnostic',
    });
    expect(classifyProviderLimitEvidence({ message: 'quota limit: 100 remaining: 95' })).toMatchObject({
      category: 'unknown',
      confidence: 'diagnostic',
    });
    for (const httpStatus of [500, 501, 502, 503, 504, 524, 529, 599]) {
      expect(classifyProviderLimitEvidence({ status: httpStatus })).toEqual({
        category: 'capacity',
        confidence: 'high',
        quotaScope: 'unknown',
        provenance: { kind: 'structured', httpStatus },
      });
    }
    expect(
      PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1
        .structuredResponseStatuses,
    ).toEqual([
      {
        statuses: [400],
        category: 'validation_failed',
        quotaScope: 'unknown',
      },
      {
        statuses: [401],
        category: 'auth_invalid',
        quotaScope: 'unknown',
      },
      {
        statuses: [402],
        category: 'plan_invalid',
        quotaScope: 'unknown',
      },
      {
        statuses: [429],
        category: 'rate_limit',
        quotaScope: 'unknown',
      },
      {
        range: { min: 500, max: 599 },
        category: 'capacity',
        quotaScope: 'unknown',
      },
    ]);

  });

  it('does not turn broad authentication prose into actionful authentication evidence', () => {
    expect(classifyProviderLimitEvidence({ message: '401 invalid bearer token' })).toEqual({
      category: 'unknown',
      confidence: 'diagnostic',
      quotaScope: 'unknown',
      provenance: { kind: 'stableProviderMessage' },
    });
    expect(classifyProviderLimitEvidence({ code: 'authentication_error' })).toEqual({
      category: 'auth_invalid',
      confidence: 'high',
      quotaScope: 'unknown',
      provenance: { kind: 'structured', providerCode: 'authentication_error' },
    });
  });

  it('does not infer provider capacity from unrelated unavailable metadata', () => {
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { status: 429 },
    })).toMatchObject({ category: 'validation_failed' });
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { note: 'Provider unavailable translation key' },
    })).toMatchObject({ category: 'validation_failed' });
    expect(classifyProviderLimitEvidence({ message: 'Provider unavailable' })).toMatchObject({
      category: 'capacity',
    });
  });
});
