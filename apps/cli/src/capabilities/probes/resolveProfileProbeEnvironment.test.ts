import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { resolveProfileProbeEnvironment } from './resolveProfileProbeEnvironment';

describe('resolveProfileProbeEnvironment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('materializes the selected profile variables and Saved Secrets for every probe backend', async () => {
    // The current reader also observes Account mode and authoring memory. Keep
    // those owners real and provide only the exact Home HTTP responses.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(options?.headers?.Authorization).toBe('Bearer token');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      throw new Error(`Unexpected profile probe HTTP path: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      throw new Error('A profile preflight with no legacy authoring memory must not write');
    });
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const encryptedValue = encryptSecretStringV1(
      'profile-api-key',
      settingsKey,
      (length) => new Uint8Array(length).fill(3),
    );

    const accountSettings = {
        profiles: [{
          id: 'work',
          name: 'Work',
          environmentVariables: [
            { name: 'CODEX_HOME', value: '/profiles/work/codex' },
            { name: 'OPENAI_API_KEY', value: '${PROFILE_OPENAI_API_KEY}' },
          ],
          envVarRequirements: [{ name: 'PROFILE_OPENAI_API_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true },
          defaultEnabled: true,
          isBuiltIn: false,
        }],
        secrets: [{
          id: 'personal-profile-key',
          name: 'Profile API key',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, encryptedValue },
        }],
        secretBindingsByProfileId: {
          work: { PROFILE_OPENAI_API_KEY: 'personal-profile-key' },
        },
      };
    const credentials = {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: recoverySecret },
      };
    const expected = {
      cacheKey: 'work',
      env: {
        CODEX_HOME: '/profiles/work/codex',
        HAPPIER_SESSION_PROFILE_ID: 'work',
        OPENAI_API_KEY: 'profile-api-key',
        PROFILE_OPENAI_API_KEY: 'profile-api-key',
      },
    };

    for (const agentId of ['codex', 'acme.review/reviewer']) {
      await expect(resolveProfileProbeEnvironment({
        agentId,
        profileId: 'work',
        accountSettings,
        credentials,
        processEnv: { HOME: '/home/alice' },
      })).resolves.toEqual(expected);
    }
    expect(post).not.toHaveBeenCalled();
  });
});
