import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema, deriveAccountMachineKeyFromRecoverySecret, deriveSettingsSecretsKeyV1, encryptSecretStringV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { createProviderCliFixture } from '@/testkit/process/providerCliFixture';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSessionRuntimeSnapshot } from '../sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

const credentials: Credentials = { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
const key = deriveSettingsSecretsKeyV1(deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(7)));
const profile = AIBackendProfileSchema.parse({
  id: 'custom-provider', name: 'Custom provider',
  environmentVariables: [
    { name: 'ANTHROPIC_BASE_URL', value: 'https://provider.example/anthropic' },
    { name: 'ANTHROPIC_MODEL', value: 'provider-model' },
  ],
  envVarRequirements: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true }],
  compatibilityByTargetKey: { 'agent:claude': true },
  createdAt: 0, updatedAt: 0,
});
const settings = {
  profiles: [profile],
  secretBindingsByProfileId: { 'custom-provider': { ANTHROPIC_AUTH_TOKEN: 'saved-key' } },
  secrets: [{ id: 'saved-key', name: 'Provider key', kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('profile-token', key, (length) => new Uint8Array(length).fill(3)) },
    createdAt: 0, updatedAt: 0 }],
};

async function resume(accountSettings: Record<string, unknown> | null = settings, environmentVariables?: Record<string, string>) {
  const { spawnOptions } = resolveSessionRuntimeSnapshot({
    incomingOptions: { directory: '.', existingSessionId: 'session-1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, environmentVariables },
    persistedMetadata: { profileId: profile.id, claudeSessionId: 'vendor-1' },
  });
  return resolveSpawnChildEnvironment({
    options: spawnOptions, profileEnvironmentVariables: spawnOptions.environmentVariables ?? {},
    daemonSpawnHooks: null,
    processEnv: { ...await createProviderCliFixture(['claude']), ANTHROPIC_AUTH_TOKEN: 'ambient-native-token', ANTHROPIC_MODEL: 'ambient-model' },
    logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    ...{ accountSettings, credentials },
  });
}

describe('profile-backed resume', () => {
  it('restores the stored profile and decrypts its bound secret instead of using ambient auth', async () => {
    const result = await resume();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild).toMatchObject({
      HAPPIER_SESSION_PROFILE_ID: profile.id,
      ANTHROPIC_BASE_URL: 'https://provider.example/anthropic',
      ANTHROPIC_MODEL: 'provider-model', ANTHROPIC_AUTH_TOKEN: 'profile-token',
    });
  });

  it.each([
    ['missing profile', { ...settings, profiles: [] }],
    ['missing bound secret', { ...settings, secrets: [] }],
    ['unavailable settings', null],
  ])('fails closed with %s even when ambient auth exists', async (_label, accountSettings) => {
    const result = await resume(accountSettings);
    expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
  });

  it('fills missing profile values while retaining explicit caller environment', async () => {
    const result = await resume(settings, { ANTHROPIC_AUTH_TOKEN: 'session-only-token', EXTRA: 'kept' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://provider.example/anthropic',
      ANTHROPIC_MODEL: 'provider-model', ANTHROPIC_AUTH_TOKEN: 'session-only-token', EXTRA: 'kept',
    });
  });
});
