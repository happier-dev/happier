import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { initialMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';

describe('initialMachineMetadata', () => {
  it('reads the fallback host name when metadata is consumed, not at module load', () => {
    const hostname = vi.spyOn(os, 'hostname').mockReturnValue('renamed-host.local');
    try {
      expect(initialMachineMetadata.host).toBe('renamed-host.local');
    } finally {
      hostname.mockRestore();
    }
  });

  it('advertises daemon-owned runtime control capabilities', () => {
    expect(initialMachineMetadata.daemonTerminalSessionAttachSupported).toBe(true);
    expect(initialMachineMetadata.daemonSessionGoalControlsSupported).toBe(true);
  });

  it('refreshes owner fields without dropping user-owned metadata', () => {
    const current = {
      host: 'old-host',
      platform: 'darwin',
      happyCliVersion: 'old',
      homeDir: '/old-home',
      happyHomeDir: '/old-happier-home',
      happyLibDir: '/old-lib',
      displayName: 'Company gateway',
      devcontainerChild: {
        relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const, parentMachineId: 'controller' },
        observation: { nativeResourceId: 'native-child', user: 'custom-user', workspaceFolder: '/work/custom',
          storage: { kind: 'child' as const, childPath: '/work/custom' } },
      },
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, {
      host: 'new-host',
      platform: 'linux',
      happyCliVersion: 'new',
      homeDir: '/new-home',
      happyHomeDir: '/new-happier-home',
      happyLibDir: '/new-lib',
    })).toEqual({
      ...current,
      host: 'new-host',
      platform: 'linux',
      happyCliVersion: 'new',
      homeDir: '/new-home',
      happyHomeDir: '/new-happier-home',
      happyLibDir: '/new-lib',
      daemonTerminalSessionAttachSupported: true,
      daemonSessionGoalControlsSupported: true,
    });
  });

  it('returns the existing metadata object when every daemon-owned field is current', () => {
    const current = {
      ...initialMachineMetadata,
      displayName: 'Build box',
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, {
      host: current.host,
      platform: current.platform,
      happyCliVersion: current.happyCliVersion,
      homeDir: current.homeDir,
      happyHomeDir: current.happyHomeDir,
      happyLibDir: current.happyLibDir,
    })).toBe(current);
  });

  it('republishes a current admitted namespace after retained-home rebuild without changing user metadata', () => {
    const relation = { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const, parentMachineId: 'controller' };
    const observation = { nativeResourceId: 'old-native', user: 'coder', workspaceFolder: '/work/custom',
      storage: { kind: 'child' as const, childPath: '/work/custom' } };
    const current = { ...initialMachineMetadata, displayName: 'My child', devcontainerChild: { relation, observation } };
    const replacement = { relation, observation: { ...observation, nativeResourceId: 'replacement-native' } };
    const fields = { host: current.host, platform: current.platform, happyCliVersion: current.happyCliVersion,
      homeDir: current.homeDir, happyHomeDir: current.happyHomeDir, happyLibDir: current.happyLibDir,
      devcontainerChild: replacement };
    const published = refreshMachineMetadataForCurrentDaemon(current, fields);
    expect(published).toMatchObject({ displayName: 'My child', devcontainerChild: replacement });
    expect(refreshMachineMetadataForCurrentDaemon(published, fields)).toBe(published);
    const retired = refreshMachineMetadataForCurrentDaemon(published, { ...fields, devcontainerChild: null });
    expect(retired.devcontainerChild).toBeUndefined();
    expect(retired.displayName).toBe('My child');
  });

  it('publishes the daemon\'s CLI update facts (K5) and republishes only when they change', () => {
    const cliUpdate = {
      currentVersion: '0.3.1',
      latestVersion: '0.3.2',
      channel: 'stable' as const,
      installSource: 'managed' as const,
      updateCommand: 'happier self update',
      canUpdateRemotely: true,
      lastUpdate: { targetVersion: '0.3.1', outcome: 'succeeded' as const, at: 5, message: null },
    };
    const fields = {
      host: initialMachineMetadata.host,
      platform: initialMachineMetadata.platform,
      happyCliVersion: initialMachineMetadata.happyCliVersion,
      homeDir: initialMachineMetadata.homeDir,
      happyHomeDir: initialMachineMetadata.happyHomeDir,
      happyLibDir: initialMachineMetadata.happyLibDir,
    };
    const published = refreshMachineMetadataForCurrentDaemon(initialMachineMetadata, { ...fields, cliUpdate });
    expect(published).toMatchObject({ cliUpdate });
    expect(refreshMachineMetadataForCurrentDaemon(published, { ...fields, cliUpdate: { ...cliUpdate } })).toBe(published);
    const rolledBack = { ...cliUpdate, lastUpdate: { targetVersion: '0.3.2', outcome: 'rolledBack' as const, at: 9, message: 'restored' } };
    expect(refreshMachineMetadataForCurrentDaemon(published, { ...fields, cliUpdate: rolledBack })).toMatchObject({ cliUpdate: rolledBack });
  });
});
