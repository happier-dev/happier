import { describe, expect, it } from 'vitest';

import {
  buildTrackedSessionRespawnEnvironmentVariables,
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
  'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

describe('sessionRunnerRespawnDescriptor', () => {
  it('canonicalizes legacy agentRuntimeDescriptorV1 respawn carriers onto runtimeDescriptorV1', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });
    expect(descriptor).not.toHaveProperty('agentRuntimeDescriptorV1');

    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor)).toMatchObject({
      directory: '/tmp/repo',
      approvedNewDirectoryCreation: true,
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });
  });

  it('round-trips mcpSelection through the respawn descriptor', () => {
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-session-1',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-session-1',
      approvedNewDirectoryCreation: true,
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    });
  });

  it('round-trips connected-service materialization identity through the respawn descriptor', () => {
    const identity = {
      v: 1,
      id: 'csm_respawn',
      createdAt: 123,
    };
    const identityJson = JSON.stringify(identity);
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
    } as SpawnSessionOptions & Record<string, unknown>);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips windows terminal modes through the respawn descriptor', () => {
    const spawnOptions = {
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
      approvedNewDirectoryCreation: true,
    });
  });

  it('tolerates newer persisted respawn fields while preserving known ones', () => {
    const parsed = SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      futureFlag: true,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    });
  });

  it('fails closed when a V1 backendTarget carrier is injected into canonical spawn options before respawn persistence', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as never,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
    });
    expect(descriptor?.backendTarget).toBeUndefined();
  });

  it('persists legacy experimentalCodexAcp spawn options as canonical codexBackendMode only', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexAcp');

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('experimentalCodexAcp');
  });

  it('hydrates legacy persisted experimentalCodexAcp descriptors onto canonical codexBackendMode', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      experimentalCodexAcp: true,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexAcp');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('experimentalCodexAcp');
  });

  it('hydrates legacy experimentalCodexResume descriptors onto canonical codexBackendMode', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      experimentalCodexResume: true,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexResume');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips canonical codex backend mode through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      codexBackendMode: 'appServer',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips agent mode overrides through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips session config-option overrides without workspace context through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          speed: { updatedAt: 10, value: 'fast' },
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      sessionConfigOptionOverrides: {
        v: 1,
        overrides: {
          speed: { value: 'fast' },
        },
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        overrides: {
          speed: { value: 'fast' },
        },
      },
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('workspaceId');
    expect(restored).not.toHaveProperty('workspaceLocationId');
    expect(restored).not.toHaveProperty('workspaceCheckoutId');
  });

  it('persists safe respawn environment variables and seals the rest for continuity', () => {
    const credentials = {
      type: 'dataKey' as const,
      machineKey: new Uint8Array(32).fill(7),
    };

    const descriptor = (buildSessionRunnerRespawnDescriptorV1FromSpawnOptions as unknown as (
      spawnOptions: SpawnSessionOptions,
      options?: { encryptionMaterial?: typeof credentials },
    ) => ReturnType<typeof buildSessionRunnerRespawnDescriptorV1FromSpawnOptions>)(
      {
        directory: '/tmp/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
          OPENAI_API_KEY: 'test-key',
        },
        connectedServices: {
          v: 1,
          bindings: {
            codex: { profileId: 'work' },
          },
        },
      } satisfies SpawnSessionOptions,
      {
        encryptionMaterial: credentials,
      },
    );

    expect(descriptor).toMatchObject({
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
    });
    expect(descriptor).toMatchObject({
      sealedEnvironmentVariables: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
    });
    expect(descriptor?.environmentVariables).not.toHaveProperty('OPENAI_API_KEY');

    const restored = (buildSpawnSessionOptionsFromRespawnDescriptorV1 as unknown as (
      descriptor: NonNullable<ReturnType<typeof buildSessionRunnerRespawnDescriptorV1FromSpawnOptions>>,
      options?: { encryptionMaterial?: typeof credentials },
    ) => SpawnSessionOptions)(descriptor!, {
      encryptionMaterial: credentials,
    });
    expect(restored).toMatchObject({
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
      },
      approvedNewDirectoryCreation: true,
    });
    expect(restored.environmentVariables).toMatchObject({
      OPENAI_API_KEY: 'test-key',
    });
  });

  it('builds tracked respawn environment variables from expanded env plus safe child runtime locators only', () => {
    const identityJson = JSON.stringify({ v: 1, id: 'csm_child_env', createdAt: 321 });
    expect(buildTrackedSessionRespawnEnvironmentVariables({
      expandedEnvironmentVariables: {
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
        CODEX_HOME: '/tmp/codex-home',
      },
      extraEnvForChild: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
        HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: '["OPENAI_API_KEY"]',
        HAPPIER_SESSION_REQUESTED_DIRECTORY: '/tmp/repo',
        HAPPIER_CODEX_BACKEND_MODE: 'acp',
      },
    })).toEqual({
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
      CODEX_HOME: '/tmp/codex-home',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
    });
  });
});
