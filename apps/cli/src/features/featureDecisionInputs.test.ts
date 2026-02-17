import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import {
  createCliFeatureDecisionInputs,
  loadCliFeatureDecisionInputsForServer,
} from './featureDecisionInputs';

function createFeaturesResponse(): FeaturesResponse {
  return FeaturesResponseSchema.parse({
    features: {
      bugReports: { enabled: true },
    },
    capabilities: {
      bugReports: {
        providerUrl: 'https://reports.happier.dev',
      },
    },
  });
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
    expect(inputs.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED).toBe('0');
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

  it('does not fetch server snapshot when global policy denies the feature', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => createFeaturesResponse(),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchSpy);

    const inputs = await loadCliFeatureDecisionInputsForServer({
      featureId: 'bugReports',
      env: {
        HAPPIER_BUILD_FEATURES_DENY: 'bugReports',
      } as NodeJS.ProcessEnv,
      serverUrl: 'https://api.example.test',
      timeoutMs: 300,
    });

    expect(inputs.serverSnapshot).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
