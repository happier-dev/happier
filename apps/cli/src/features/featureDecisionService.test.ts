import { describe, expect, it } from 'vitest';
import type { FeaturesResponse } from '@happier-dev/protocol';

import {
  resolveCliFeatureDecision,
  type CliServerFeaturesSnapshot,
} from './featureDecisionService';

function buildFeaturesResponse(overrides?: Partial<FeaturesResponse['features']>): FeaturesResponse {
  const base: FeaturesResponse = {
    features: {
      bugReports: {
        enabled: true,
        providerUrl: 'https://reports.happier.dev',
        defaultIncludeDiagnostics: true,
        maxArtifactBytes: 10 * 1024 * 1024,
        acceptedArtifactKinds: ['cli', 'daemon', 'server'],
        uploadTimeoutMs: 20_000,
        contextWindowMs: 30 * 60 * 1000,
      },
      automations: {
        enabled: true,
        existingSessionTarget: true,
      },
      sharing: {
        session: { enabled: true },
        public: { enabled: true },
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
          enabled: true,
          allowUsername: false,
          requiredIdentityProviderId: null,
        },
      },
      oauth: {
        providers: {
          github: {
            enabled: true,
            configured: true,
          },
        },
      },
      auth: {
        signup: {
          methods: [{ id: 'anonymous', enabled: true }],
        },
        login: {
          requiredProviders: [],
        },
        recovery: {
          providerReset: {
            enabled: false,
            providers: [],
          },
        },
        ui: {
          autoRedirect: {
            enabled: false,
            providerId: null,
          },
          recoveryKeyReminder: {
            enabled: true,
          },
        },
        providers: {
          github: {
            enabled: true,
            configured: true,
            restrictions: {
              usersAllowlist: false,
              orgsAllowlist: false,
              orgMatch: 'any',
            },
            offboarding: {
              enabled: false,
              intervalSeconds: 600,
              mode: 'per-request-cache',
              source: 'oauth_user_token',
            },
          },
        },
        misconfig: [],
      },
    },
  };

  if (!overrides) return base;
  return {
    features: {
      ...base.features,
      ...overrides,
      bugReports: {
        ...base.features.bugReports,
        ...(overrides.bugReports ?? {}),
      },
      automations: {
        ...base.features.automations,
        ...(overrides.automations ?? {}),
      },
    },
  };
}

describe('resolveCliFeatureDecision', () => {
  it('enables bugReports when server and local policy enable the feature', () => {
    const snapshot: CliServerFeaturesSnapshot = {
      status: 'ready',
      features: buildFeaturesResponse(),
    };

    const decision = resolveCliFeatureDecision({
      featureId: 'bugReports',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot: snapshot,
    });

    expect(decision.state).toBe('enabled');
    expect(decision.blockedBy).toBeNull();
  });

  it('fails closed when the server features endpoint is missing', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'bugReports',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot: {
        status: 'unsupported',
        reason: 'endpoint_missing',
      },
    });

    expect(decision.state).toBe('unsupported');
    expect(decision.blockerCode).toBe('endpoint_missing');
  });

  it('disables automations when the local env gate is off', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'automations',
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'false',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('local_policy');
  });

  it('disables automations when build policy denies the feature', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'automations',
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true',
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('build_policy');
  });
});
