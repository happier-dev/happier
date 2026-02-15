import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';
import {
  createCliFeatureDecisionInputs,
  loadCliFeatureDecisionInputsForServer,
} from './featureDecisionInputs';

function createFeaturesResponse(): FeaturesResponse {
  return {
    features: {
      bugReports: {
        enabled: true,
        providerUrl: 'https://reports.happier.dev',
        defaultIncludeDiagnostics: true,
        maxArtifactBytes: 10 * 1024 * 1024,
        acceptedArtifactKinds: ['cli', 'daemon', 'server'],
        uploadTimeoutMs: 20_000,
        contextWindowMs: 30 * 60 * 1_000,
      },
      automations: {
        enabled: true,
        existingSessionTarget: false,
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
        signup: { methods: [{ id: 'anonymous', enabled: true }] },
        login: { requiredProviders: [] },
        recovery: { providerReset: { enabled: false, providers: [] } },
        ui: {
          autoRedirect: { enabled: false, providerId: null },
          recoveryKeyReminder: { enabled: true },
        },
        providers: {
          github: {
            enabled: true,
            configured: true,
            restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
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
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('featureDecisionInputs', () => {
  it('derives build and local policies from env', () => {
    const inputs = createCliFeatureDecisionInputs({
      featureId: 'automations',
      env: {
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
      } as NodeJS.ProcessEnv,
    });

    expect(inputs.buildPolicy).toBe('deny');
    expect(inputs.localPolicyEnabled).toBe(false);
    expect(inputs.serverSnapshot).toBeUndefined();
  });

  it('derives local policy for execution.runs from env', () => {
    const inputs = createCliFeatureDecisionInputs({
      featureId: 'execution.runs',
      env: {
        HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: '0',
      } as NodeJS.ProcessEnv,
    });

    expect(inputs.localPolicyEnabled).toBe(false);
  });

  it('loads server snapshot when resolving inputs for a server URL', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => createFeaturesResponse(),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchSpy);

    const inputs = await loadCliFeatureDecisionInputsForServer({
      featureId: 'bugReports',
      env: {} as NodeJS.ProcessEnv,
      serverUrl: 'https://api.example.test',
      timeoutMs: 300,
    });

    expect(inputs.serverSnapshot?.status).toBe('ready');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
