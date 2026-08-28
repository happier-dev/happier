import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('resolveSpawnChildEnvironment provider overlay composition', () => {
  const sessionBindingMetadata = {
    v: 1 as const,
    connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
    contributionKey: 'plugin.openrouter/openrouter',
    connectionRevision: 1,
    protocol: 'openai-responses' as const,
    materialization: 'spawnEnv' as const,
    adapterBindingKey: 'openrouter',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-v1',
    displaySnapshot: {
      providerName: 'OpenRouter',
      connectionName: 'Work',
      connectionRole: 'named' as const,
      connectionDisplayNameMode: 'custom' as const,
    },
  };
  it('runs provider-bound prerequisites once before authorization and does not rerun them in full composition', async () => {
    const resolveRuntimePrerequisites = vi.fn(async (selection) => {
      expect(selection).toMatchObject({ hasExternalModelBinding: true });
      expect(selection).not.toHaveProperty('providerBinding');
      expect(JSON.stringify(selection)).not.toContain('pc_gateway');
      expect(JSON.stringify(selection)).not.toContain('model-a');
      return { ok: true as const };
    });
    const augmentEnv = vi.fn(() => ({ AUGMENTED: 'yes' }));
    const common = {
      options: { directory: '/repo' },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: { resolveRuntimePrerequisites, augmentEnv },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      providerBindingContext: {
        v: 1 as const,
        agentTargetKey: 'codex',
        connectionId: 'pc_gateway',
        modelId: 'model-a',
      },
    };

    const preflight = await resolveSpawnChildEnvironment({
      ...common,
      providerBindingPrerequisitesOnly: true,
    });
    expect(preflight.ok).toBe(true);
    expect(augmentEnv).not.toHaveBeenCalled();

    const full = await resolveSpawnChildEnvironment({
      ...common,
      runtimePrerequisitesAlreadyResolved: true,
    });
    expect(full).toMatchObject({ ok: true, extraEnvForChild: { AUGMENTED: 'yes' } });
    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    expect(augmentEnv).toHaveBeenCalledTimes(1);
  });

  it('invokes late provider materialization after generic hooks and applies its overlay last', async () => {
    const events: string[] = [];
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '/repo' },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv: () => {
          events.push('hook');
          return { COLLISION: 'hook' };
        },
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      materializeProviderBindingAfterHooks: async () => {
        events.push('provider');
        return {
          ok: true as const,
          providerEnvironmentOverlay: [
            { name: 'COLLISION', value: 'provider', source: 'provider' as const },
          ],
          providerBindingLaunchHandoff: {
            v: 1 as const,
            materialization: { v: 1 as const, kind: 'spawnEnv' as const },
            sessionBindingMetadata,
          },
        };
      },
    });

    expect(events).toEqual(['hook', 'provider']);
    expect(result).toMatchObject({
      ok: true,
      extraEnvForChild: { COLLISION: 'provider' },
      providerBindingLaunchHandoff: {
        v: 1,
        materialization: { v: 1, kind: 'spawnEnv' },
        sessionBindingMetadata,
      },
    });
  });

  it('preserves a typed Provider error from late materialization', async () => {
    const providerError = createProviderErrorV1('provider_credential_transport_unavailable', {
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    });
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '/repo' },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      materializeProviderBindingAfterHooks: async () => ({
        ok: false as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: providerError.code,
        providerError,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_credential_transport_unavailable',
      providerError,
    });
  });

  it.each([
    {
      name: 'invalid provider overlay',
      daemonSpawnHooks: null,
      providerEnvironmentOverlay: [
        { name: 'PROVIDER_KEY', value: 'secret', source: 'invalid-source' },
      ],
    },
  ])('cleans connected-service materialization exactly once when $name throws', async ({
    daemonSpawnHooks,
    providerEnvironmentOverlay,
  }) => {
    const cleanupOnFailure = vi.fn();
    const cleanupOnExit = vi.fn();

    await expect(resolveSpawnChildEnvironment({
      options: { directory: '/repo' },
      profileEnvironmentVariables: {},
      daemonSpawnHooks,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { CONNECTED_SECRET: 'materialized' },
        cleanupOnFailure,
        cleanupOnExit,
      },
      providerEnvironmentOverlay: providerEnvironmentOverlay as never,
    })).rejects.toThrow();

    expect(cleanupOnFailure).toHaveBeenCalledTimes(1);
    expect(cleanupOnExit).not.toHaveBeenCalled();
  });

  it('returns a typed no-spawn result when environment augmentation throws', async () => {
    const cleanupOnFailure = vi.fn();
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '/repo' },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv: () => {
          throw new Error('plugin-private failure');
        },
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { CONNECTED_SECRET: 'materialized' },
        cleanupOnFailure,
        cleanupOnExit: null,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Agent daemon spawn environment hook failed.',
    });
    expect(cleanupOnFailure).not.toHaveBeenCalled();
    expect(result.cleanupOnFailure).toBe(cleanupOnFailure);
  });

  it.each(['spoofed-profile', null])(
    'keeps daemon-owned profile identity when provider operation is %j',
    async (value) => {
      const result = await resolveSpawnChildEnvironment({
        options: { directory: '/repo', profileId: 'work' },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: {},
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
        providerEnvironmentOverlay: [
          { name: 'HAPPIER_SESSION_PROFILE_ID', value, source: 'provider' },
        ],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.extraEnvForChild.HAPPIER_SESSION_PROFILE_ID).toBe('work');
      expect(result.unsetEnvKeys).not.toContain('HAPPIER_SESSION_PROFILE_ID');
    },
  );

  it('reapplies every resolver-owned session control after provider operations', async () => {
    const options: SpawnSessionOptions = {
      directory: '/repo',
      profileId: 'work',
      transcriptStorage: 'direct',
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: [],
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: { speed: { updatedAt: 123, value: 'fast' } },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'happier',
          },
        },
      },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_provider_overlay_test',
        createdAt: 123,
      },
    } as SpawnSessionOptions;
    const systemKeys = [
      'HAPPIER_SESSION_PROFILE_ID',
      'HAPPIER_TRANSCRIPT_STORAGE',
      'HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY',
      'HAPPIER_SESSION_MCP_SELECTION_JSON',
      'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON',
      'HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON',
      'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON',
      'HAPPIER_SESSION_REQUESTED_DIRECTORY',
      'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
    ] as const;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      providerEnvironmentOverlay: systemKeys.map((name) => ({
        name,
        value: 'provider-must-not-win',
        source: 'provider' as const,
      })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild).toMatchObject({
      HAPPIER_SESSION_PROFILE_ID: 'work',
      HAPPIER_TRANSCRIPT_STORAGE: 'direct',
      HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY: 'replace_with_runtime_identity',
      HAPPIER_SESSION_MCP_SELECTION_JSON: JSON.stringify(options.mcpSelection),
      HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON: JSON.stringify(options.sessionConfigOptionOverrides),
      HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON: JSON.stringify(options.connectedServices),
      HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON: JSON.stringify(
        options.connectedServiceMaterializationIdentityV1,
      ),
      HAPPIER_SESSION_REQUESTED_DIRECTORY: '/repo',
    });
    expect(result.extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON).not.toBe(
      'provider-must-not-win',
    );
    expect(result.unsetEnvKeys).toEqual([]);
  });


  it('applies D-6 precedence without exposing provider materialization to hooks or respawn values', async () => {
    const augmentEnv = vi.fn((runtimeSelection: Readonly<Record<string, unknown>>) => ({
      COLLISION: 'generic-hook',
      GENERIC_ONLY: 'hook',
      HAPPIER_HOME_DIR: '/hook-must-not-win',
      HOOK_SAW_PROVIDER_SECRET: JSON.stringify(runtimeSelection).includes('provider-secret') ? 'yes' : 'no',
    }));
    const options: SpawnSessionOptions = {
      directory: '/repo',
      transcriptStorage: 'direct',
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        COLLISION: 'profile',
        PROFILE_ONLY: 'profile',
      },
      daemonSpawnHooks: {
        augmentEnv,
      },
      processEnv: {
        COLLISION: 'ambient',
        TO_UNSET: 'ambient-secret',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: {
          COLLISION: 'connected-auth',
          CONNECTED_ONLY: 'connected',
          HAPPIER_HOME_DIR: '/auth-must-not-win',
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
          HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: 'canonical-materialized-keys',
          HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/canonical/materialized-root',
        },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
      providerEnvironmentOverlay: [
        { name: 'COLLISION', value: 'provider', source: 'provider' },
        { name: 'PROVIDER_SECRET', value: 'provider-secret', source: 'provider' },
        { name: 'LITERAL_VALUE', value: '${DO_NOT_EXPAND}', source: 'provider' },
        { name: 'EMPTY_VALUE', value: '', source: 'provider' },
        { name: 'TO_UNSET', value: null, source: 'provider' },
        { name: 'HAPPIER_HOME_DIR', value: '/provider-must-not-win', source: 'provider' },
        { name: 'HAPPIER_TRANSCRIPT_STORAGE', value: 'provider-must-not-win', source: 'provider' },
        { name: 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', value: 'provider-must-not-win', source: 'provider' },
        { name: 'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON', value: 'provider-must-not-win', source: 'provider' },
        { name: 'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT', value: '/provider-must-not-win', source: 'provider' },
        { name: 'TMUX_SESSION_NAME', value: 'provider-must-not-select-terminal', source: 'provider' },
        { name: 'TMUX_TMPDIR', value: '/provider-must-not-select-tmux-dir', source: 'provider' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild).toMatchObject({
      COLLISION: 'provider',
      PROFILE_ONLY: 'profile',
      CONNECTED_ONLY: 'connected',
      GENERIC_ONLY: 'hook',
      PROVIDER_SECRET: 'provider-secret',
      LITERAL_VALUE: '${DO_NOT_EXPAND}',
      EMPTY_VALUE: '',
      HOOK_SAW_PROVIDER_SECRET: 'no',
      HAPPIER_TRANSCRIPT_STORAGE: 'direct',
      HAPPIER_SESSION_REQUESTED_DIRECTORY: '/repo',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: 'canonical-materialized-keys',
      HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/canonical/materialized-root',
    });
    expect(result.extraEnvForChild.HAPPIER_HOME_DIR).toBeUndefined();
    expect(result.extraEnvForChild.TMUX_SESSION_NAME).toBeUndefined();
    expect(result.extraEnvForChild.TMUX_TMPDIR).toBeUndefined();
    expect(result.extraEnvForChild.TO_UNSET).toBeUndefined();
    expect(result.unsetEnvKeys).toContain('TO_UNSET');

    expect(result.expandedEnvironmentVariables).toMatchObject({
      COLLISION: 'connected-auth',
      PROFILE_ONLY: 'profile',
      CONNECTED_ONLY: 'connected',
    });
    expect(result.expandedEnvironmentVariables.PROVIDER_SECRET).toBeUndefined();
    expect(result.expandedEnvironmentVariables.GENERIC_ONLY).toBeUndefined();

    const marker = JSON.parse(result.extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON ?? '[]');
    expect(marker).toEqual(expect.arrayContaining([
      'COLLISION',
      'PROFILE_ONLY',
      'CONNECTED_ONLY',
      'PROVIDER_SECRET',
      'LITERAL_VALUE',
      'EMPTY_VALUE',
      'TO_UNSET',
    ]));
    expect(JSON.stringify(marker)).not.toContain('provider-secret');
    expect(augmentEnv).toHaveBeenCalledTimes(1);
  });
});
