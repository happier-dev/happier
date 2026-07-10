import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Gemini agent definition runtime contributions', () => {
  it('exports a plugin-owned provider catalog runtime contribution', () => {
    expect(AGENT_DEFINITION.runtimeContributions).toMatchObject({
      agentCatalogEntry: {
        importName: 'GEMINI_AGENT_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
    });
  });

  it('does not advertise deferred OAuth, ADC, or machine-login auth facts', () => {
    const forbiddenFacts = [
      'oauth_creds.json',
      'auth.json',
      'application_default_credentials.json',
      'gcloud ADC',
      'gemini auth',
    ];
    const serializedDefinition = JSON.stringify(AGENT_DEFINITION);

    for (const forbiddenFact of forbiddenFacts) {
      expect(serializedDefinition).not.toContain(forbiddenFact);
    }
    expect(AGENT_DEFINITION.authProbeConfig.envVars).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
    ]);
    expect(AGENT_DEFINITION.authProbeConfig.parser).toBe('envOnly');
    expect(AGENT_DEFINITION.authProbeConfig.credentialPaths ?? []).toEqual([]);
    expect(AGENT_DEFINITION.localCli).toEqual(expect.objectContaining({
      supportKind: 'unsupported',
      loginLaunch: null,
    }));
    expect(AGENT_DEFINITION.localCli.machineLoginKey).not.toBe('gemini-cli');
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
