import { describe, expect, it } from 'vitest';

import { coerceBugReportsFeatureFromFeaturesPayload, DEFAULT_BUG_REPORTS_FEATURE, FeaturesResponseSchema } from './features.js';

describe('FeaturesResponseSchema backward compatibility', () => {
  it('accepts payloads missing bugReports and applies safe defaults', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          session: { enabled: true },
          public: { enabled: false },
          contentKeys: { enabled: true },
          pendingQueueV2: { enabled: false },
        },
        voice: {
          enabled: false,
          configured: false,
          provider: null,
        },
        social: {
          friends: {
            enabled: false,
            allowUsername: false,
            requiredIdentityProviderId: null,
          },
        },
        oauth: {
          providers: {},
        },
        auth: {
          signup: { methods: [] },
          login: { requiredProviders: [] },
          recovery: { providerReset: { enabled: false, providers: [] } },
          ui: {
            autoRedirect: { enabled: false, providerId: null },
            recoveryKeyReminder: { enabled: false },
          },
          providers: {},
          misconfig: [],
        },
      },
    });

    expect(parsed.features.bugReports.enabled).toBe(false);
    expect(parsed.features.bugReports.providerUrl).toBeNull();
    expect(parsed.features.bugReports.defaultIncludeDiagnostics).toBe(true);
    expect(parsed.features.bugReports.contextWindowMs).toBe(30 * 60 * 1000);
    expect(parsed.features.automations.enabled).toBe(false);
    expect(parsed.features.automations.existingSessionTarget).toBe(false);
  });

  it('coerces bug report feature from sparse payloads', () => {
    const coerced = coerceBugReportsFeatureFromFeaturesPayload({
      features: {
        bugReports: {
          enabled: true,
          providerUrl: 'https://reports.happier.dev/',
          acceptedArtifactKinds: ['cli', '', 'daemon'],
          uploadTimeoutMs: 9000,
          contextWindowMs: 45000,
        },
      },
    });

    expect(coerced.enabled).toBe(true);
    expect(coerced.providerUrl).toBe('https://reports.happier.dev');
    expect(coerced.defaultIncludeDiagnostics).toBe(DEFAULT_BUG_REPORTS_FEATURE.defaultIncludeDiagnostics);
    expect(coerced.maxArtifactBytes).toBe(DEFAULT_BUG_REPORTS_FEATURE.maxArtifactBytes);
    expect(coerced.acceptedArtifactKinds).toEqual(['cli', 'daemon']);
    expect(coerced.uploadTimeoutMs).toBe(9000);
    expect(coerced.contextWindowMs).toBe(45000);
  });

  it('returns safe default bug report feature when payload is missing or invalid', () => {
    expect(coerceBugReportsFeatureFromFeaturesPayload({ features: {} })).toEqual(DEFAULT_BUG_REPORTS_FEATURE);
    expect(
      coerceBugReportsFeatureFromFeaturesPayload({
        features: {
          bugReports: {
            enabled: true,
            providerUrl: 'not-a-url',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_FEATURE);
    expect(
      coerceBugReportsFeatureFromFeaturesPayload({
        features: {
          bugReports: {
            enabled: true,
            providerUrl: 'ftp://reports.happier.dev',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_FEATURE);
  });

  it('normalizes provider url by stripping query/hash while preserving path prefix', () => {
    const coerced = coerceBugReportsFeatureFromFeaturesPayload({
      features: {
        bugReports: {
          enabled: true,
          providerUrl: 'https://reports.happier.dev/api/?token=abc#frag',
        },
      },
    });

    expect(coerced.providerUrl).toBe('https://reports.happier.dev/api');
  });

  it('accepts payloads missing automations and applies safe defaults', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        bugReports: {
          enabled: true,
          providerUrl: 'https://reports.happier.dev',
          defaultIncludeDiagnostics: true,
          maxArtifactBytes: 10 * 1024 * 1024,
          acceptedArtifactKinds: ['cli'],
          uploadTimeoutMs: 10_000,
          contextWindowMs: 30 * 60 * 1000,
        },
        sharing: {
          session: { enabled: true },
          public: { enabled: false },
          contentKeys: { enabled: true },
          pendingQueueV2: { enabled: false },
        },
        voice: {
          enabled: false,
          configured: false,
          provider: null,
        },
        social: {
          friends: {
            enabled: false,
            allowUsername: false,
            requiredIdentityProviderId: null,
          },
        },
        oauth: {
          providers: {},
        },
        auth: {
          signup: { methods: [] },
          login: { requiredProviders: [] },
          recovery: { providerReset: { enabled: false, providers: [] } },
          ui: {
            autoRedirect: { enabled: false, providerId: null },
            recoveryKeyReminder: { enabled: false },
          },
          providers: {},
          misconfig: [],
        },
      },
    });

    expect(parsed.features.automations).toEqual({
      enabled: false,
      existingSessionTarget: false,
    });
  });
});
