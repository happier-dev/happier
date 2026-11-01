import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { initialMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';
import { MachinePublishedMetadataV1Schema, StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { resolveAcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { createRegistryHostV1 } from '../../../../../packages/protocol/src/registries/registryHostV1';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../../../../../packages/protocol/src/registries/registrySourcesV1';
import { ACP_REGISTRY_V1_FIXTURE } from '../../../../../packages/protocol/src/registries/formats/fixtures/acpRegistryV1Fixture';
import { buildMachineDisplayMetadata } from '../../../../ui/sources/sync/domains/machines/machineDisplayRenderable';

describe('initialMachineMetadata', () => {
  it('publishes native architecture through the strict Machine reader and the real registry platform-fit consumer', async () => {
    const published = StoredMachinePublishedMetadataV1Schema.parse(MachinePublishedMetadataV1Schema.parse(initialMachineMetadata));
    const display = buildMachineDisplayMetadata(published)!;
    expect(display.arch).toBe(os.arch());
    const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
    const host = createRegistryHostV1({ host: 'web', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { getJson: async () => ({ ok: true, value: ACP_REGISTRY_V1_FIXTURE, fetchedAt: 1 }), getText: unused, getBytes: unused } });
    const response = await host.fetchRequest({ op: 'read', kind: 'agent', sourceId: 'builtin:acp-registry', itemId: 'junie' });
    if (response.op !== 'read' || response.item.payload.kind !== 'agent') throw new Error('Missing registry Agent');
    expect(resolveAcpPlatformFitV1(response.item.payload.agent.distributions, {
      platform: display.platform ?? null, arch: display.arch ?? null,
    })).toMatchObject({ kind: 'can_run', via: 'archive', target: `${process.platform}-${process.arch}` });
    // Retained metadata from a different execution architecture must be republished,
    // even when no other field changes; a second identical refresh remains inert.
    const fields = { host: published.host, platform: published.platform, arch: os.arch(),
      happyCliVersion: published.happyCliVersion, homeDir: published.homeDir,
      happyHomeDir: published.happyHomeDir, happyLibDir: published.happyLibDir };
    for (const priorArch of [undefined, 'stale-processor']) {
      const current = { ...published, arch: priorArch, displayName: 'Build box' };
      const refreshed = refreshMachineMetadataForCurrentDaemon(current, fields);
      expect(refreshed).not.toBe(current);
      expect(MachinePublishedMetadataV1Schema.parse(refreshed)).toMatchObject({ arch: os.arch(), displayName: 'Build box' });
      expect(refreshMachineMetadataForCurrentDaemon(refreshed, fields)).toBe(refreshed);
    }
  });
  it('publishes new install observations even when the other daemon fields are unchanged', () => {
    const current = { ...initialMachineMetadata, displayName: 'Build box' };
    const fields = { host: current.host, platform: current.platform, happyCliVersion: current.happyCliVersion,
      homeDir: current.homeDir, happyHomeDir: current.happyHomeDir, happyLibDir: current.happyLibDir,
      agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } };
    const published = refreshMachineMetadataForCurrentDaemon(current, fields);
    expect(published).toMatchObject({ displayName: 'Build box', agentInventory: fields.agentInventory });
    expect(refreshMachineMetadataForCurrentDaemon(published, fields)).toBe(published);
    const removed = refreshMachineMetadataForCurrentDaemon(published, { ...fields,
      agentInventory: { checkedAt: 3, installedAgentIds: [] } });
    expect(removed).toMatchObject({ agentInventory: { checkedAt: 3, installedAgentIds: [] } });
  });
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
