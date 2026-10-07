import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
import {
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { resolveProfileProbeEnvironment } from './resolveProfileProbeEnvironment';

describe('resolveProfileProbeEnvironment', () => {
  beforeEach(() => {
    // Account HTTP transport is the system boundary; profile parsing and secret materialization stay real.
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { version: 0, content: { t: 'plain', v: {} } } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path.includes('authoring-memory')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: null } } };
      throw new Error(`Unexpected account request: ${path}`);
    });
  });
  it('materializes a one-launch strict saved-secret reference for an otherwise unbound profile requirement', async () => {
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(deriveAccountMachineKeyFromRecoverySecret(recoverySecret));
    const encryptedValue = encryptSecretStringV1('selected-secret', settingsKey, (length) => new Uint8Array(length).fill(3));
    const request = {
      agentId: 'codex', profileId: 'work',
      accountSettings: {
        profiles: [{ id: 'work', name: 'Work', environmentVariables: [{ name: 'OPENAI_API_KEY', value: '${PROFILE_KEY}' }],
          envVarRequirements: [{ name: 'PROFILE_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true }, defaultEnabled: true, isBuiltIn: false }],
        secrets: [{ id: 'selected-key', name: 'Selected key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue } }],
      },
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: recoverySecret } },
      processEnv: { HOME: '/home/alice' },
      secretReferenceOverlay: { v: 1 as const, bindings: { PROFILE_KEY: { ref: 'selected-key' } } },
    };
    await expect(resolveProfileProbeEnvironment(request)).resolves.toEqual({ cacheKey: 'work', env: {
      HAPPIER_SESSION_PROFILE_ID: 'work', OPENAI_API_KEY: 'selected-secret', PROFILE_KEY: 'selected-secret',
    } });
  });

  it('materializes the selected profile variables and Saved Secrets for every probe backend', async () => {
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
  });
});
