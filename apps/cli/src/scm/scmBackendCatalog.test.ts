import { describe, expect, it } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import type { ScmBackendRegistry } from './registry';
import type { ScmBackend } from './types';
import {
  createScmBackendCatalog,
  resolveDefaultScmBackendRegistry,
} from './scmBackendCatalog';

async function withFirstPartyScmRuntime<T>(
  run: (registry: ScmBackendRegistry) => T | Promise<T>,
): Promise<T> {
  const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: [
      'happier.scm.backend.git',
      'happier.scm.backend.sapling',
    ],
  });
  try {
    return await run(await resolveDefaultScmBackendRegistry({
      pluginRuntimeRegistry: runtimeRegistry,
    }));
  } finally {
    await runtimeRegistry.dispose();
  }
}

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
    expect(createScmBackendCatalog().map((backend) => backend.id)).toEqual([]);

    await withFirstPartyScmRuntime((resolvedRegistry) => {
      expect(resolvedRegistry.listBackends().map((backend) => backend.id)).toEqual([
        'happier.scm.backend.git/git',
        'happier.scm.backend.sapling/sapling',
      ]);
    });
  });

  it('routes static support through provider-owned grouped capability declarations', async () => {
    await withFirstPartyScmRuntime((registry) => {
      const backends = registry.listBackends();

      expect(backends.map((backend) => ({
        id: backend.id,
        hasGroupedDeclaration: 'declaredCapabilities' in backend,
        flatCapabilities: backend.getCapabilities({
          mode: backend.id === 'happier.scm.backend.git/git' ? '.git' : '.sl',
        }),
      }))).toEqual([
        expect.objectContaining({
          id: 'happier.scm.backend.git/git',
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
          id: 'happier.scm.backend.sapling/sapling',
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
  });

  it('keeps unknown repo mode from exposing full flat backend capabilities', async () => {
    await withFirstPartyScmRuntime((registry) => {
      for (const backend of registry.listBackends()) {
        expect(backend.getCapabilities({ mode: null })).toEqual(expect.objectContaining({
          readStatus: false,
          writeCommit: false,
          writeRemotePush: false,
          worktreeCreate: false,
        }));
      }
    });
  });
});
