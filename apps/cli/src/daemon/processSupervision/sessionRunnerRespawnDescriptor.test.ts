import { describe, expect, it } from 'vitest';

import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

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
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
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

  it('round-trips environment variables and connected-services bindings through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      environmentVariables: {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
      },
      connectedServices: {
        v: 1,
        bindings: {
          codex: { profileId: 'work' },
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      environmentVariables: {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
      },
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      environmentVariables: {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
      },
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
      approvedNewDirectoryCreation: true,
    });
  });
});
