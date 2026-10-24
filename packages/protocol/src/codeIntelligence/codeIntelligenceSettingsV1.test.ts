import { describe, expect, it } from 'vitest';

import {
  CodeIntelligenceSettingsV1Schema,
  normalizeCodeIntelligenceSettings,
  redactCodeIntelligenceSettingsSecrets,
} from './codeIntelligenceSettingsV1.js';

describe('code intelligence settings', () => {
  it('defaults to observation off, no remote upload, free-only routing and no paid spend', () => {
    const settings = normalizeCodeIntelligenceSettings(undefined);

    expect(settings.enabled).toBe(false);
    expect(settings.remoteAnalysis.enabled).toBe(false);
    expect(settings.remoteAnalysis.allowedRepositoryIds).toEqual([]);
    expect(settings.remoteAnalysis.routingPolicy).toBe('free_only');
    expect(settings.remoteAnalysis.allowPaid).toBe(false);
    expect(settings.remoteAnalysis.monthlyBudgetUsd).toBe(0);
  });

  it('treats a provider without a declared billing class as paid', () => {
    const settings = normalizeCodeIntelligenceSettings({
      remoteAnalysis: { providers: [{ id: 'p1', kind: 'openrouter', modelId: 'some/model' }] },
    });

    expect(settings.remoteAnalysis.providers[0]?.billing).toBe('paid');
  });

  it('degrades malformed persisted settings to the fail-closed defaults', () => {
    const settings = normalizeCodeIntelligenceSettings({ enabled: 'yes', remoteAnalysis: { enabled: 1 } });

    expect(settings.enabled).toBe(false);
    expect(settings.remoteAnalysis.enabled).toBe(false);
  });

  it('rejects an OpenAI-compatible provider without an endpoint', () => {
    expect(CodeIntelligenceSettingsV1Schema.safeParse({
      remoteAnalysis: { providers: [{ id: 'local', kind: 'openai_compatible', modelId: 'm', billing: 'free' }] },
    }).success).toBe(false);
    expect(CodeIntelligenceSettingsV1Schema.safeParse({
      remoteAnalysis: { providers: [{ id: 'local', kind: 'openai_compatible', modelId: 'm', billing: 'free', baseUrl: 'http://127.0.0.1:8080/v1' }] },
    }).success).toBe(true);
  });

  it('never returns key material to clients', () => {
    const settings = normalizeCodeIntelligenceSettings({
      remoteAnalysis: {
        providers: [{
          id: 'groq',
          kind: 'groq',
          modelId: 'm',
          billing: 'free',
          apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
        }],
      },
    });

    const redacted = redactCodeIntelligenceSettingsSecrets(settings);

    expect(redacted.remoteAnalysis.providers[0]?.apiKey).toEqual({ _isSecretValue: true });
  });
});
