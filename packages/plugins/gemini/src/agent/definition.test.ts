import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Gemini agent definition', () => {
  it('keeps the public Agent definition free of private runtime aggregates', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
  });

  it('does not advertise deferred OAuth, ADC, or machine-login auth facts', () => {
    const forbiddenFacts = [
      'oauth_creds.json',
      'auth.json',
      'application_default_credentials.json',
      'gcloud ADC',
      'gemini auth',
    ];
    const serializedDefinition = JSON.stringify({
      definition: AGENT_DEFINITION,
      manifest: PLUGIN_MANIFEST,
    });

    for (const forbiddenFact of forbiddenFacts) {
      expect(serializedDefinition).not.toContain(forbiddenFact);
    }
    const cli = PLUGIN_MANIFEST.contributes.agents[0]?.cli;
    expect(cli?.auth.environmentVariables).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
    ]);
    expect(cli?.auth.credentialPaths ?? []).toEqual([]);
    expect(cli?.auth).toEqual(expect.objectContaining({
      support: 'unsupported',
      loginLaunches: [],
    }));
    expect(cli?.auth.machineLoginKey).not.toBe('gemini-cli');
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
  });

  it('constrains freeform Gemini model ids to Gemini resource names', () => {
    expect(AGENT_DEFINITION.modelConfig).toMatchObject({
      supportsFreeform: true,
      dynamicProbe: 'static-only',
      freeformModelIdPrefixes: [
        'gemini-',
        'models/gemini-',
        'publishers/google/models/gemini-',
      ],
    });
  });

  it('does not advertise usage-limit check-now without a recovery control adapter', () => {
    expect(AGENT_DEFINITION.core.sessionCapabilities.usageLimitRecovery)
      .toEqual({ checkNow: 'unsupported' });
  });
});
