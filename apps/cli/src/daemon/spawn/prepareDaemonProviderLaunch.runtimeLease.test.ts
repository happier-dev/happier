import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  createProviderErrorV1,
} from '@happier-dev/protocol';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { SpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';

const hoisted = vi.hoisted(() => ({
  prepareProviderLaunch: vi.fn(),
  createRuntimeProviderSpawnAuthorizationAttempt: vi.fn(),
  resolveSpawnChildEnvironment: vi.fn(),
}));

vi.mock('@/providers/lifecycle/prepareLaunch', () => ({
  prepareProviderLaunch: hoisted.prepareProviderLaunch,
}));

vi.mock('@/providers/spawn/authorize', () => {
  return {
    createRuntimeProviderSpawnAuthorizationAttempt:
      hoisted.createRuntimeProviderSpawnAuthorizationAttempt,
  };
});

vi.mock('./resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: hoisted.resolveSpawnChildEnvironment,
}));

import { prepareDaemonProviderLaunch } from './prepareDaemonProviderLaunch';

describe('prepareDaemonProviderLaunch runtime lease currentness', () => {
  it('rejects an impossible native mode before acquiring a runtime lease', async () => {
    hoisted.prepareProviderLaunch.mockReset();
    hoisted.prepareProviderLaunch.mockResolvedValue({ ok: true, kind: 'native' });
    const acceptedRegistry = Object.freeze({});
    const acceptedLease = Object.freeze({
      registry: acceptedRegistry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    }) as unknown as Awaited<ReturnType<SpawnPluginRuntimeLease['acquire']>>;
    const acquire = vi.fn(async () => acceptedLease);
    const pluginRuntimeLease = Object.freeze({
      currentRegistry: acceptedRegistry,
      acquire,
      release: vi.fn(async () => undefined),
    }) as unknown as SpawnPluginRuntimeLease;

    await expect(prepareDaemonProviderLaunch({
      options: {
        directory: '/repo',
        machineId: 'machine-a',
        agentModeId: 'plan',
        backendTarget: {
          kind: 'backend',
          sourceKind: 'built_in',
          backendId: 'gemini',
        },
      },
      effectiveBackendTarget: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'gemini',
      },
      catalogAgentId: 'gemini',
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      persistedProviderBinding: null,
      normalizedExistingSessionId: '',
      pluginRuntimeLease,
      launchResourceScope: createProviderLaunchResourceScope(),
      processEnv: {},
    })).resolves.toMatchObject({
      ok: false,
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      },
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(hoisted.prepareProviderLaunch).not.toHaveBeenCalled();
  });

  it('uses one accepted spawn lease for provider authorization and prerequisite hooks', async () => {
    const acceptedRegistry = Object.freeze({});
    // These collaborators only observe lease/registry identity in this boundary test.
    const acceptedLease = Object.freeze({
      registry: acceptedRegistry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    }) as unknown as Awaited<ReturnType<SpawnPluginRuntimeLease['acquire']>>;
    const acquire = vi.fn(async () => acceptedLease);
    const pluginRuntimeLease = Object.freeze({
      currentRegistry: acceptedRegistry,
      acquire,
      release: vi.fn(async () => undefined),
    }) as unknown as SpawnPluginRuntimeLease;
    const selection = {
      v: 1 as const,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
        modelId: 'model-a',
      },
    };

    hoisted.resolveSpawnChildEnvironment.mockResolvedValue({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValue({
      ok: false,
      error: createProviderErrorV1('provider_settings_invalid', {
        connectionId: selection.ref.providerConnectionId,
        machineId: 'machine-a',
      }),
    });
    hoisted.prepareProviderLaunch.mockImplementation(
      async (
        input: Parameters<
          typeof import('@/providers/lifecycle/prepareLaunch').prepareProviderLaunch
        >[0],
      ) => {
        await input.resolvePrerequisites({
          agentTargetKey: 'backend:codex',
          connectionId: selection.ref.providerConnectionId,
          modelId: 'model-a',
        });
        await input.createAuthorizationAttempt({
          selection,
          machineId: 'machine-a',
          agentTargetKey: 'backend:codex',
          agentId: 'codex',
        });
        return { ok: true as const, kind: 'native' as const };
      },
    );

    await expect(prepareDaemonProviderLaunch({
      options: {
        directory: '/repo',
        machineId: 'machine-a',
        backendTarget: {
          kind: 'backend',
          sourceKind: 'built_in',
          backendId: 'codex',
        },
      },
      effectiveBackendTarget: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      catalogAgentId: 'codex',
      modelSelection: selection,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      persistedProviderBinding: null,
      normalizedExistingSessionId: 'existing-session-a',
      pluginRuntimeLease,
      launchResourceScope: createProviderLaunchResourceScope(),
      resolveProvidersFeatureEnabled: async () => true,
      processEnv: {},
    })).resolves.toMatchObject({
      ok: true,
      attempt: null,
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveSpawnChildEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginRuntimeRegistry: acceptedRegistry,
      }),
    );
    expect(hoisted.createRuntimeProviderSpawnAuthorizationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: acceptedLease,
        sessionId: 'existing-session-a',
      }),
    );
    expect(hoisted.prepareProviderLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'existing-session-a',
      }),
    );
  });

  it('does not invent a Provider session identity for a fresh external launch', async () => {
    const acceptedRegistry = Object.freeze({});
    const acceptedLease = Object.freeze({
      registry: acceptedRegistry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    }) as unknown as Awaited<ReturnType<SpawnPluginRuntimeLease['acquire']>>;
    const pluginRuntimeLease = Object.freeze({
      currentRegistry: acceptedRegistry,
      acquire: vi.fn(async () => acceptedLease),
      release: vi.fn(async () => undefined),
    }) as unknown as SpawnPluginRuntimeLease;
    const selection = {
      v: 1 as const,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
        modelId: 'model-a',
      },
    };
    let preparedInput:
      Parameters<
        typeof import('@/providers/lifecycle/prepareLaunch').prepareProviderLaunch
      >[0]
      | null = null;
    hoisted.prepareProviderLaunch.mockImplementationOnce(async (input) => {
      preparedInput = input;
      await input.createAuthorizationAttempt({
        selection,
        machineId: 'machine-a',
        agentTargetKey: 'backend:codex',
        agentId: 'codex',
      });
      return { ok: true as const, kind: 'native' as const };
    });
    hoisted.createRuntimeProviderSpawnAuthorizationAttempt.mockResolvedValueOnce({
      ok: false,
      error: createProviderErrorV1('provider_settings_invalid', {
        connectionId: selection.ref.providerConnectionId,
        machineId: 'machine-a',
      }),
    });

    await prepareDaemonProviderLaunch({
      options: {
        directory: '/repo',
        sessionId: 'caller-reservation',
        machineId: 'machine-a',
        backendTarget: {
          kind: 'backend',
          sourceKind: 'built_in',
          backendId: 'codex',
        },
      },
      effectiveBackendTarget: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      catalogAgentId: 'codex',
      modelSelection: selection,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      persistedProviderBinding: null,
      normalizedExistingSessionId: '',
      pluginRuntimeLease,
      launchResourceScope: createProviderLaunchResourceScope(),
      resolveProvidersFeatureEnabled: async () => true,
      processEnv: {},
    });

    expect(preparedInput).not.toBeNull();
    expect(preparedInput).not.toHaveProperty('sessionId');
    expect(hoisted.createRuntimeProviderSpawnAuthorizationAttempt)
      .toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: expect.anything() }));
  });
});
