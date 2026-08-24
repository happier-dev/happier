import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('keeps its static catalog leaf behavior-identical to the legacy runtime entrypoint', async () => {
    const catalogPath = fileURLToPath(new URL('./catalog.ts', import.meta.url));
    expect(existsSync(catalogPath)).toBe(true);
    if (!existsSync(catalogPath)) return;

    expect(readFileSync(catalogPath, 'utf8')).not.toContain('./runtime');

    const { ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION: catalogContribution } = await import('./catalog.js');

    expect(catalogContribution).toBe(ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION);
    expect(catalogContribution.connectedServices.shouldRestartForServiceSwitch?.({ serviceId: 'gemini' })).toBe(true);
    expect(catalogContribution.connectedServices.shouldRestartForServiceSwitch?.({ serviceId: 'openai' })).toBe(false);
  });

  it('proves only provider activity bound to the exact Antigravity credential epoch', async () => {
    const adapter = ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION.connectedServices.runtimeAuthAdapter as unknown as Readonly<{
      verifyProviderOutcome?: (input: unknown) => Promise<unknown>;
    }>;
    const exactSelection = {
      kind: 'profile',
      serviceId: 'gemini',
      profileId: 'vertex-work',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    };

    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'antigravity' },
      selections: [exactSelection],
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toEqual({
      status: 'verified',
      source: 'antigravity_provider_activity',
      targets: [{
        serviceId: 'gemini',
        profileId: 'vertex-work',
        groupId: null,
        groupGeneration: null,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
    });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'antigravity' },
      selections: [{ ...exactSelection, credentialRevision: undefined }],
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'antigravity' },
      selections: [exactSelection],
      outcome: { kind: 'provider_activity', event: 'task_started' },
    })).resolves.toMatchObject({ status: 'unavailable' });
  });
});
