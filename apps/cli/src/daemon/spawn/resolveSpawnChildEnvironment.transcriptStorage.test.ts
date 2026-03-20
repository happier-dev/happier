import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('resolveSpawnChildEnvironment (transcript storage)', () => {
  it('sets HAPPIER_TRANSCRIPT_STORAGE=direct when transcriptStorage=direct', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '/tmp',
        transcriptStorage: 'direct',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.HAPPIER_TRANSCRIPT_STORAGE).toBe('direct');
  });

  it('omits HAPPIER_TRANSCRIPT_STORAGE when transcriptStorage is unset', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '/tmp',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.HAPPIER_TRANSCRIPT_STORAGE).toBeUndefined();
  });

  it('sets HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY when requested', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '/tmp',
        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY).toBe('replace_with_runtime_identity');
  });
});
