import { describe, expect, it } from 'vitest';

import type { ScmBackend } from './types';
import {
  createScmBackendCatalog,
  defaultScmBackendRegistry,
  resolveDefaultScmBackendRegistry,
  resolveScmRuntimePluginIds,
} from './scmBackendCatalog';

describe('scmBackendCatalog', () => {
  it('merges registered plugin backends through the catalog without editing built-in provider arrays', () => {
    const pluginBackend = {
      id: 'acme-vcs',
      selection: {
        modeSelectionScores: {
          '.git': 25,
        },
        preferenceAllowedModes: ['.git'],
      },
      detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
      getCapabilities: () => ({
        readStatus: true,
        readDiff: false,
        writeCommit: false,
        writeRemotePush: false,
      }),
    } as unknown as ScmBackend;
    const backends = (createScmBackendCatalog as (input?: {
      pluginBackends?: readonly ScmBackend[];
    }) => readonly ScmBackend[])({
      pluginBackends: [pluginBackend],
    });

    expect(backends.map((backend) => backend.id)).toEqual(['acme-vcs']);
  });

  it('keeps the synchronous host catalog provider-neutral while loading first-party SCM backends from bundled plugins', async () => {
    expect(defaultScmBackendRegistry.listBackends().map((backend) => backend.id)).toEqual([]);

    const resolvedRegistry = await resolveDefaultScmBackendRegistry();

    expect(resolvedRegistry.listBackends().map((backend) => backend.id)).toEqual(['git', 'sapling']);
  });

  it('limits SCM runtime activation to plugins that own SCM backend contributions', () => {
    const pluginIds = resolveScmRuntimePluginIds({
      activationTargets: [
        { pluginId: 'happier.agent.codex' },
        { pluginId: 'happier.scm.backend.git' },
        { pluginId: 'happier.scm.backend.sapling' },
        { pluginId: 'happier.scm.hosting.github' },
      ],
      scmBackends: [
        { pluginId: 'happier.scm.backend.git' },
        { pluginId: 'happier.scm.backend.sapling' },
      ],
      scmHostingProviders: [
        { pluginId: 'happier.scm.hosting.github' },
      ],
    });

    expect(pluginIds).toEqual([
      'happier.scm.backend.git',
      'happier.scm.backend.sapling',
      'happier.scm.hosting.github',
    ]);
  });

  it('routes static support through provider-owned grouped capability declarations', async () => {
    const backends = (await resolveDefaultScmBackendRegistry()).listBackends();

    expect(backends.map((backend) => ({
      id: backend.id,
      hasGroupedDeclaration: 'declaredCapabilities' in backend,
      flatCapabilities: backend.getCapabilities({ mode: backend.id === 'git' ? '.git' : '.sl' }),
    }))).toEqual([
      expect.objectContaining({
        id: 'git',
        hasGroupedDeclaration: true,
        flatCapabilities: expect.objectContaining({
          readStatus: true,
          writeCommit: true,
          writeRemoteFetch: true,
          writeRemotePull: true,
          writeRemotePush: true,
          readBranches: true,
          changeSetModel: 'index',
          supportedDiffAreas: ['included', 'pending', 'both'],
        }),
      }),
      expect.objectContaining({
        id: 'sapling',
        hasGroupedDeclaration: true,
        flatCapabilities: expect.objectContaining({
          readStatus: true,
          writeCommit: true,
          writeRemoteFetch: false,
          writeRemotePull: false,
          writeRemotePush: false,
          readBranches: false,
          changeSetModel: 'working-copy',
          supportedDiffAreas: ['pending', 'both'],
        }),
      }),
    ]);
  });

  it('keeps unknown repo mode from exposing full flat backend capabilities', async () => {
    const registry = await resolveDefaultScmBackendRegistry();
    const backends = registry.listBackends();

    for (const backend of backends) {
      expect(backend.getCapabilities({ mode: null })).toEqual(expect.objectContaining({
        readStatus: false,
        writeCommit: false,
        writeRemotePush: false,
        worktreeCreate: false,
      }));
    }
  });
});
