import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import {
  AIBackendProfileSchema,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

function makeCredentials(): Credentials {
  return {
    token: 'token-test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function assertLegacyCredentials(credentials: Credentials): asserts credentials is Credentials & {
  encryption: { type: 'legacy'; secret: Uint8Array };
} {
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('expected legacy credentials');
  }
}

function makeDeepSeekProfile() {
  return AIBackendProfileSchema.parse({
    id: 'deepseek',
    name: 'DeepSeek (Reasoner)',
    envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
      { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
    ],
    defaultPermissionModeByTargetKey: { 'agent:claude': 'default' },
    compatibilityByTargetKey: { 'agent:claude': true, 'agent:codex': false, 'agent:gemini': false },
    isBuiltIn: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  });
}

describe('buildProfileEnvOverlay', () => {
  it('applies a slim profile without invoking legacy secret resolution', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');
    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
      profile: {
        v: 2, id: 'slim', name: 'Slim',
        extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '${TEAM_FLAG_SOURCE:-on}' }],
        defaultPermissionModeByTargetKey: { 'agent:claude': 'acceptEdits' },
        defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: { 'agent:claude': true },
        createdAt: 1, updatedAt: 1,
      },
      processEnv: {},
      promptSecretFn: async () => { throw new Error('must not prompt'); },
      reservedEnvironmentVariableNames: new Set(),
      requiredSecretRequirementNamesMissingBinding: new Set(),
    });
    expect(result).toEqual({
      envOverlayRaw: { TEAM_FLAG: '${TEAM_FLAG_SOURCE:-on}' },
      foregroundSatisfiedSecretRequirementNames: [],
      permissionModeSeed: 'acceptEdits',
    });
  });
  it('exports buildProfileEnvOverlay', async () => {
    await expect(import('./buildProfileEnvOverlay.js')).resolves.toMatchObject({
      buildProfileEnvOverlay: expect.any(Function),
    });
  });

  it('rejects adapter-owned environment keys from the authoritative runtime projection before resolving secrets', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');
    await expect(buildProfileEnvOverlay({
      agentId: 'codex',
      profile: {
        v: 2, id: 'unsafe', name: 'Unsafe',
        extraEnvironmentVariables: [{ name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'must-not-win' }],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      },
      processEnv: {}, promptSecretFn: null,
      reservedEnvironmentVariableNames: new Set(['HAPPIER_CODEX_PROVIDER_API_KEY', 'CODEX_API_KEY']),
      requiredSecretRequirementNamesMissingBinding: new Set(),
    })).rejects.toThrow(/reserved/);
    await expect(buildProfileEnvOverlay({
      agentId: 'codex',
      profile: {
        v: 2, id: 'unsafe-requirement', name: 'Unsafe requirement',
        extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'safe' }],
        envVarRequirements: [{ name: 'CODEX_API_KEY', kind: 'secret', required: true }],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      },
      processEnv: {}, promptSecretFn: null,
      reservedEnvironmentVariableNames: new Set(['HAPPIER_CODEX_PROVIDER_API_KEY', 'CODEX_API_KEY']),
      requiredSecretRequirementNamesMissingBinding: new Set(['CODEX_API_KEY']),
    })).rejects.toThrow(/reserved/);
  });

  it('uses secrets from process env when present and expands templates against injected overlay', async () => {
    const {
      buildProfileEnvOverlay,
      expandProfileEnvOverlay,
    } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      processEnv: { DEEPSEEK_AUTH_TOKEN: 'sk-from-env' },
      promptSecretFn: null,
      reservedEnvironmentVariableNames: new Set(),
      requiredSecretRequirementNamesMissingBinding:
        new Set(['DEEPSEEK_AUTH_TOKEN']),
    });

    const expanded = expandProfileEnvOverlay({
      profile,
      envOverlayRaw: result.envOverlayRaw,
      processEnv: { DEEPSEEK_AUTH_TOKEN: 'sk-from-env' },
      resolvedEnvironment: {},
    });
    expect(expanded.DEEPSEEK_AUTH_TOKEN).toBe('sk-from-env');
    expect(expanded.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-env');
    expect(expanded.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(expanded.API_TIMEOUT_MS).toBe('600000');
    expect(result.permissionModeSeed).toBe('default');
  });

  it('defers a saved secret binding to the daemon without prompting or decrypting', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    const promptSecretFn = vi.fn(async () => {
      throw new Error('prompt should not be called');
    });

    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      processEnv: {},
      promptSecretFn,
      reservedEnvironmentVariableNames: new Set(),
      requiredSecretRequirementNamesMissingBinding: new Set(),
    });

    expect(promptSecretFn).not.toHaveBeenCalled();
    expect(result.envOverlayRaw).not.toHaveProperty(
      'DEEPSEEK_AUTH_TOKEN',
    );
    expect(result.envOverlayRaw.ANTHROPIC_AUTH_TOKEN).toBe(
      '${DEEPSEEK_AUTH_TOKEN}',
    );
  });

  it('lets the daemon identify a padded SavedSecret id as a missing binding', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');
    const { readForegroundProfileRequiredSecretNamesMissingBinding } =
      await import(
        '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment'
      );
    const profile = makeDeepSeekProfile();
    const missing =
      readForegroundProfileRequiredSecretNamesMissingBinding({
        profile,
        accountSettings: {
          secrets: [{
            id: 's1', name: 'DeepSeek', kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'must-not-resolve' },
            createdAt: 0, updatedAt: 0,
          }],
          secretBindingsByProfileId: {
            deepseek: { DEEPSEEK_AUTH_TOKEN: ' s1 ' },
          },
        },
      });
    expect(missing).toEqual(['DEEPSEEK_AUTH_TOKEN']);
    await expect(buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      processEnv: {}, promptSecretFn: null,
      reservedEnvironmentVariableNames: new Set(),
      requiredSecretRequirementNamesMissingBinding: new Set(missing),
    })).rejects.toThrow(/Missing required secret environment variable/);
  });

  it('decrypts canonical machine-key-sealed saved secrets only through the daemon helper', async () => {
    const { resolveForegroundProfileSavedSecretEnvironment } =
      await import(
        '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment'
      );

    const profile = makeDeepSeekProfile();
    const credentials = makeCredentials();
    assertLegacyCredentials(credentials);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret);
    const canonicalKey = deriveSettingsSecretsKeyV1(machineKey);
    const encryptedValue = encryptSecretStringV1(
      'sk-from-canonical-saved',
      canonicalKey,
      (length) => new Uint8Array(length).fill(3),
    );

    const result = resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: {
        secrets: [
          {
            id: 's1',
            name: 'DeepSeek',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, encryptedValue },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 's1' } },
      },
      settingsSecretsReadKeys: [canonicalKey],
      foregroundSatisfiedSecretRequirementNames: [],
    });

    expect(result.DEEPSEEK_AUTH_TOKEN).toBe('sk-from-canonical-saved');
  });

  it('returns only canonical required names when a bound SavedSecret needs foreground recovery', async () => {
    const {
      ForegroundProfileSecretRecoveryRequiredError,
      resolveForegroundProfileSavedSecretEnvironment,
    } = await import(
      '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment'
    );
    const profile = makeDeepSeekProfile();
    let thrown: unknown = null;
    try {
      resolveForegroundProfileSavedSecretEnvironment({
        profile,
        accountSettings: {
          secrets: [{
            id: 's1',
            name: 'DeepSeek',
            kind: 'apiKey',
            encryptedValue: {
              _isSecretValue: true,
              encryptedValue: 'not-a-valid-secret-container',
            },
            createdAt: 0,
            updatedAt: 0,
          }],
          secretBindingsByProfileId: {
            deepseek: { DEEPSEEK_AUTH_TOKEN: 's1' },
          },
        },
        settingsSecretsReadKeys: [new Uint8Array(32).fill(1)],
        foregroundSatisfiedSecretRequirementNames: [],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(
      ForegroundProfileSecretRecoveryRequiredError,
    );
    expect(thrown).toMatchObject({
      requirementNames: ['DEEPSEEK_AUTH_TOKEN'],
    });
  });

  it('omits an unavailable optional bound SavedSecret without requesting recovery', async () => {
    const { resolveForegroundProfileSavedSecretEnvironment } =
      await import(
        '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment'
      );
    const profile = AIBackendProfileSchema.parse({
      ...makeDeepSeekProfile(),
      envVarRequirements: [{
        name: 'DEEPSEEK_AUTH_TOKEN',
        kind: 'secret',
        required: false,
      }],
    });
    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: {
        secrets: [{
          id: 's1',
          name: 'DeepSeek',
          kind: 'apiKey',
          encryptedValue: {
            _isSecretValue: true,
            encryptedValue: 'not-a-valid-secret-container',
          },
          createdAt: 0,
          updatedAt: 0,
        }],
        secretBindingsByProfileId: {
          deepseek: { DEEPSEEK_AUTH_TOKEN: 's1' },
        },
      },
      settingsSecretsReadKeys: [new Uint8Array(32).fill(1)],
      foregroundSatisfiedSecretRequirementNames: [],
    })).toEqual({});
  });

  it('rejects noncanonical foreground secret requirement names', async () => {
    const { resolveForegroundProfileSavedSecretEnvironment } =
      await import(
        '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment'
      );
    expect(() => resolveForegroundProfileSavedSecretEnvironment({
      profile: makeDeepSeekProfile(),
      accountSettings: {},
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [
        'deepseek_auth_token',
      ],
    })).toThrow(/canonical requirement names/);
  });

  it('fails fast when a required secret is missing in non-interactive mode', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    await expect(buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      processEnv: {},
      promptSecretFn: null,
      reservedEnvironmentVariableNames: new Set(),
      requiredSecretRequirementNamesMissingBinding:
        new Set(['DEEPSEEK_AUTH_TOKEN']),
    })).rejects.toThrow(/DEEPSEEK_AUTH_TOKEN/);
  });
});
