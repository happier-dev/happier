import { describe, expect, it } from 'vitest';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import {
  buildTrackedSessionRespawnEnvironmentVariables,
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { Credentials } from '@/persistence';

describe('sessionRunnerRespawnDescriptor', () => {
  it('round-trips mcpSelection through the respawn descriptor', () => {
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      futureFlag: true,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('persists legacy experimentalCodexAcp spawn options as canonical codexBackendMode only', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexAcp');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexResume');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips canonical codex backend mode through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'appServer',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips agent mode overrides through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips session config-option overrides without workspace context through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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

  it('persists only safe runtime locator environment variables in the respawn descriptor while keeping connected-services bindings', () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
        ANTHROPIC_AUTH_TOKEN: 'test-token',
      },
      connectedServices: {
        v: 1,
        bindings: {
          codex: { profileId: 'work' },
        },
      },
    } satisfies SpawnSessionOptions, {
      encryptionMaterial: credentials.encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3),
    });

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
    expect(descriptor).toHaveProperty('sealedEnvironmentVariables');
    expect(descriptor?.environmentVariables).not.toMatchObject({
      OPENAI_API_KEY: expect.any(String),
      ANTHROPIC_AUTH_TOKEN: expect.any(String),
    });
    const opened = openAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material: credentials.encryption,
      ciphertext: (descriptor as { sealedEnvironmentVariables?: { ciphertext: string } }).sealedEnvironmentVariables?.ciphertext ?? '',
    });
    expect(opened?.value).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!, {
      encryptionMaterial: credentials.encryption,
    });
    expect(restored).toMatchObject({
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
        ANTHROPIC_AUTH_TOKEN: 'test-token',
      },
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
      approvedNewDirectoryCreation: true,
    });
  });

  it('builds tracked respawn environment variables from expanded env plus safe child runtime locators only', () => {
    expect(buildTrackedSessionRespawnEnvironmentVariables({
      expandedEnvironmentVariables: {
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
        CODEX_HOME: '/tmp/codex-home',
      },
      extraEnvForChild: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: '["OPENAI_API_KEY"]',
        HAPPIER_SESSION_REQUESTED_DIRECTORY: '/tmp/repo',
        HAPPIER_CODEX_BACKEND_MODE: 'acp',
      },
    })).toEqual({
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
      CODEX_HOME: '/tmp/codex-home',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    });
  });
});
