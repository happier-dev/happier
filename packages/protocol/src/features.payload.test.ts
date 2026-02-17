import { describe, expect, it } from 'vitest';

import {
  coerceBugReportsCapabilitiesFromFeaturesPayload,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  FeaturesResponseSchema,
} from './features.js';

describe('FeaturesResponseSchema', () => {
  it('applies safe defaults for missing subtrees', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    expect(parsed.features.bugReports.enabled).toBe(false);
    expect(parsed.features.automations.enabled).toBe(false);
    expect(parsed.features.automations.existingSessionTarget.enabled).toBe(false);
    expect(parsed.features.connectedServices.enabled).toBe(false);
    expect(parsed.features.connectedServices.quotas.enabled).toBe(false);
    expect(parsed.features.updates.ota.enabled).toBe(false);
    expect(parsed.features.sharing.session.enabled).toBe(false);
    expect(parsed.features.voice.enabled).toBe(false);
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect(parsed.features.social.friends.enabled).toBe(false);
    expect(parsed.features.auth.recovery.providerReset.enabled).toBe(false);
    expect(parsed.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);

    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(parsed.capabilities.voice).toEqual({
      configured: false,
      provider: null,
      requested: false,
      disabledByBuildPolicy: false,
    });
    expect(parsed.capabilities.oauth.providers).toEqual({});
    expect(parsed.capabilities.auth.misconfig).toEqual([]);
  });

  it('coerces bug reports capabilities from sparse payloads', () => {
    const coerced = coerceBugReportsCapabilitiesFromFeaturesPayload({
      capabilities: {
        bugReports: {
          providerUrl: 'https://reports.happier.dev/',
          acceptedArtifactKinds: ['cli', '', 'daemon'],
          uploadTimeoutMs: 9000,
          contextWindowMs: 45000,
        },
      },
    });

    expect(coerced.providerUrl).toBe('https://reports.happier.dev');
    expect(coerced.defaultIncludeDiagnostics).toBe(DEFAULT_BUG_REPORTS_CAPABILITIES.defaultIncludeDiagnostics);
    expect(coerced.maxArtifactBytes).toBe(DEFAULT_BUG_REPORTS_CAPABILITIES.maxArtifactBytes);
    expect(coerced.acceptedArtifactKinds).toEqual(['cli', 'daemon']);
    expect(coerced.uploadTimeoutMs).toBe(9000);
    expect(coerced.contextWindowMs).toBe(45000);
  });

  it('returns safe default bug reports capabilities when payload is missing or invalid', () => {
    expect(coerceBugReportsCapabilitiesFromFeaturesPayload({ capabilities: {} })).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(
      coerceBugReportsCapabilitiesFromFeaturesPayload({
        capabilities: {
          bugReports: {
            providerUrl: 'not-a-url',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(
      coerceBugReportsCapabilitiesFromFeaturesPayload({
        capabilities: {
          bugReports: {
            providerUrl: 'ftp://reports.happier.dev',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
  });

  it('does not reject the whole payload when bugReports capabilities are malformed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        voice: { enabled: true },
      },
      capabilities: {
        bugReports: {
          providerUrl: 'not-a-url',
        },
      },
    });

    expect(parsed.features.voice.enabled).toBe(true);
    // Fail closed: Happier Voice must be explicitly reported by the server via `features.voice.happierVoice.enabled`.
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
  });
});
