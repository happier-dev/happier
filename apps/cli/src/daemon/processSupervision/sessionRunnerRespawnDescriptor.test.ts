import { describe, expect, it } from 'vitest';

import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
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
});
