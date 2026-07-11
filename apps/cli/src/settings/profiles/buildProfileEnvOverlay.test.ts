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
      accountSettings: {},
      credentials: makeCredentials(),
      processEnv: {},
      promptSecretFn: async () => { throw new Error('must not prompt'); },
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(),
    });
    expect(result).toEqual({ profileId: 'slim', envOverlayExpanded: { TEAM_FLAG: 'on' }, permissionModeSeed: 'acceptEdits' });
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
      accountSettings: {}, credentials: makeCredentials(), processEnv: {}, promptSecretFn: null,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(['HAPPIER_CODEX_PROVIDER_API_KEY', 'CODEX_API_KEY']),
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
      accountSettings: {}, credentials: makeCredentials(), processEnv: {}, promptSecretFn: null,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(['HAPPIER_CODEX_PROVIDER_API_KEY', 'CODEX_API_KEY']),
    })).rejects.toThrow(/reserved/);
  });

  it('uses secrets from process env when present and expands templates against injected overlay', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    const credentials = makeCredentials();

    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      accountSettings: {},
      credentials,
      processEnv: { DEEPSEEK_AUTH_TOKEN: 'sk-from-env' },
      promptSecretFn: null,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(),
    });

    expect(result.profileId).toBe('deepseek');
    expect(result.envOverlayExpanded.DEEPSEEK_AUTH_TOKEN).toBe('sk-from-env');
    expect(result.envOverlayExpanded.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-env');
    expect(result.envOverlayExpanded.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(result.envOverlayExpanded.API_TIMEOUT_MS).toBe('600000');
    expect(result.permissionModeSeed).toBe('default');
  });

  it('uses saved secret bindings when env is missing (no prompt)', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    const credentials = makeCredentials();
    const promptSecretFn = vi.fn(async () => {
      throw new Error('prompt should not be called');
    });

    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      accountSettings: {
        secrets: [
          {
            id: 's1',
            name: 'DeepSeek',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'sk-from-saved' },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 's1' } },
      },
      credentials,
      processEnv: {},
      promptSecretFn,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(),
    });

    expect(promptSecretFn).not.toHaveBeenCalled();
    expect(result.envOverlayExpanded.DEEPSEEK_AUTH_TOKEN).toBe('sk-from-saved');
    expect(result.envOverlayExpanded.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-saved');
  });

  it('refuses a padded SavedSecret id instead of trimming it into a different binding', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');
    await expect(buildProfileEnvOverlay({
      agentId: 'claude',
      profile: makeDeepSeekProfile(),
      accountSettings: {
        secrets: [{
          id: 's1', name: 'DeepSeek', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'must-not-resolve' },
          createdAt: 0, updatedAt: 0,
        }],
        secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: ' s1 ' } },
      },
      credentials: makeCredentials(), processEnv: {}, promptSecretFn: null,
      startedBy: 'daemon', reservedEnvironmentVariableNames: new Set(),
    })).rejects.toThrow(/Missing required secret environment variable/);
  });

  it('decrypts canonical machine-key-sealed saved secrets when credentials are legacy', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

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

    const result = await buildProfileEnvOverlay({
      agentId: 'claude',
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
      credentials,
      processEnv: {},
      promptSecretFn: null,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(),
    });

    expect(result.envOverlayExpanded.DEEPSEEK_AUTH_TOKEN).toBe('sk-from-canonical-saved');
    expect(result.envOverlayExpanded.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-canonical-saved');
  });

  it('fails fast when a required secret is missing in non-interactive mode', async () => {
    const { buildProfileEnvOverlay } = await import('./buildProfileEnvOverlay.js');

    const profile = makeDeepSeekProfile();
    const credentials = makeCredentials();

    await expect(buildProfileEnvOverlay({
      agentId: 'claude',
      profile,
      accountSettings: {},
      credentials,
      processEnv: {},
      promptSecretFn: null,
      startedBy: 'terminal',
      reservedEnvironmentVariableNames: new Set(),
    })).rejects.toThrow(/DEEPSEEK_AUTH_TOKEN/);
  });
});
