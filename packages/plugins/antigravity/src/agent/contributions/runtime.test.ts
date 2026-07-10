import { describe, expect, it } from 'vitest';

import { ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Antigravity agent runtime contribution', () => {
  it('exports provider-owned model preflight controls and Gemini connected-service materialization', () => {
    expect(ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION).toMatchObject({
      agentId: 'antigravity',
      preflightSessionControls: {
        failureCacheStrategy: 'cooldown',
        probeModelsRaw: expect.any(Function),
        cliModelsCommandArgs: ['models'],
      },
      connectedServices: {
        serviceIds: ['gemini'],
        materializedHomeCredentialEntries: [
          'GEMINI_API_KEY',
          'GOOGLE_API_KEY',
          'GOOGLE_GENAI_USE_VERTEXAI',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_LOCATION',
          'ANTIGRAVITY_AUTH_MODE',
          'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
          'GOOGLE_APPLICATION_CREDENTIALS',
        ],
        readConnectedServiceId: expect.any(Function),
        createAuthMaterializationInput: expect.any(Function),
        materializeAuthEnvironment: expect.any(Function),
        stateSharingDescriptor: {
          providerSupportStatus: 'unsupported',
          authIsolation: {
            mode: 'process_env',
            secretEntries: expect.arrayContaining([
              'GEMINI_API_KEY',
              'GOOGLE_API_KEY',
              'GOOGLE_GENAI_USE_VERTEXAI',
              'GOOGLE_APPLICATION_CREDENTIALS',
            ]),
          },
        },
        recoveryCapabilities: {
          predictiveSoftSwitch: { mode: 'unsupported' },
        },
        shouldRestartForServiceSwitch: expect.any(Function),
        restartRematerializeRequiredReason: 'antigravity_auth_environment_rematerialization_required',
      },
    });
  });

  it('returns explicit booleans from the service-switch restart predicate', () => {
    const predicate = ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION.connectedServices.shouldRestartForServiceSwitch;

    expect(predicate?.({ serviceId: 'gemini' })).toBe(true);
    expect(predicate?.({ serviceId: 'openai' })).toBe(false);
    expect(predicate?.(null)).toBe(false);
  });
});
