import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeExecutableShim } from '../../testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';

const { getResolvedContributionRegistry, getRuntimeRegistryState, isRuntimeRegistryCurrent } = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getRuntimeRegistryState: vi.fn<() => { activeRegistry: object | null }>(
    () => ({ activeRegistry: null }),
  ),
  isRuntimeRegistryCurrent: vi.fn(() => true),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry,
}));
vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: getRuntimeRegistryState,
    isRuntimeRegistryCurrent,
  },
}));

import {
  requireAgentCliLaunchSpec,
} from './requireAgentCliLaunchSpec';
import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';

const tempDirs = new Set<string>();

afterEach(async () => {
  getResolvedContributionRegistry.mockReset();
  getRuntimeRegistryState.mockReset();
  getRuntimeRegistryState.mockReturnValue({ activeRegistry: null });
  isRuntimeRegistryCurrent.mockReset();
  isRuntimeRegistryCurrent.mockReturnValue(true);
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

function externalRuntimeSpec(binaryName: string): AgentCliRuntimeDescriptor {
  return Object.freeze({
    id: 'acme-agent',
    title: 'Acme Agent CLI',
    binaryName,
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
  });
}

describe('requireAgentCliLaunchSpec external Agent metadata', () => {
  it('resolves the active contribution registry runtime descriptor for an external Agent', async () => {
    const root = await createTempDir('happier-external-agent-launch-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    const executable = await writeExecutableShim({
      dir: pathDir,
      fileName: 'acme-cli',
      contents: '#!/bin/sh\necho ok\n',
    });

    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme-agent', { runtimeSpec: externalRuntimeSpec('acme-cli') }],
      ]),
    });

    expect(requireAgentCliLaunchSpec('acme-agent', {
      processEnv: { PATH: pathDir },
    })).toEqual({
      source: 'system',
      resolvedPath: executable,
      command: executable,
      args: [],
    });
  });

  it('fails closed when an active Agent contribution has no runtime descriptor', () => {
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['metadata-only', { runtimeSpec: null }],
      ]),
    });

    expect(() => requireAgentCliLaunchSpec('metadata-only', {
      processEnv: { PATH: '' },
    })).toThrow("Missing agent CLI runtime metadata for 'metadata-only'");
  });

  it('detects an external Agent through the real daemon snapshot entry point', async () => {
    const root = await createTempDir('happier-external-agent-snapshot-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    const executable = await writeExecutableShim({
      dir: pathDir,
      fileName: 'acme-cli',
      contents: '#!/bin/sh\necho "acme 1.2.3"\n',
    });
    const runtimeSpec = externalRuntimeSpec('acme-cli');
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme-agent', { runtimeSpec }],
      ]),
      catalogEntriesById: {
        'acme-agent': {
          id: 'acme-agent',
          getCliDetect: async () => ({
            versionArgsToTry: [['--version']],
            loginStatusArgs: null,
          }),
          getCliAuthSpec: async () => ({
            binaryNames: ['acme-cli'],
          }),
        },
      },
    });
    const previousPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      const snapshot = await detectCliSnapshotOnDaemonPath({
        requestedCliNames: ['acme-agent'],
        bypassCache: true,
      });
      expect(snapshot.clis['acme-agent']).toMatchObject({
        available: true,
        resolvedPath: executable,
        resolutionSource: 'system',
        version: '1.2.3',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('detects an external Agent added to the current registry after the cold catalog cache was primed', async () => {
    const root = await createTempDir('happier-current-external-agent-snapshot-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    const executable = await writeExecutableShim({
      dir: pathDir,
      fileName: 'current-acme',
      contents: '#!/bin/sh\necho "current-acme 1.2.3"\n',
    });
    const runtimeSpec = externalRuntimeSpec('current-acme');
    const coldRegistry = {
      agentDefinitionsById: new Map(),
      catalogEntriesById: {},
    };
    getResolvedContributionRegistry.mockReturnValue(coldRegistry);

    expect(Object.keys((await import('@/agent/catalog/registry')).AGENTS)).toEqual([]);

    getRuntimeRegistryState.mockReturnValue({
      activeRegistry: {
        contributes: {
          agentDefinitionsById: new Map([
            ['acme-agent', { runtimeSpec }],
          ]),
          catalogEntriesById: {
            'acme-agent': {
              id: 'acme-agent',
              getCliDetect: async () => ({
                versionArgsToTry: [['--version']],
                loginStatusArgs: null,
              }),
              getCliAuthSpec: async () => ({
                binaryNames: ['current-acme'],
              }),
            },
          },
        },
      },
    });

    const previousPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      const snapshot = await detectCliSnapshotOnDaemonPath({
        requestedCliNames: ['acme-agent'],
        bypassCache: true,
      });
      expect(snapshot.clis['acme-agent']).toMatchObject({
        available: true,
        resolvedPath: executable,
        resolutionSource: 'system',
        version: '1.2.3',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('prefers the current daemon runtime contribution over a stale cold registry snapshot', async () => {
    const root = await createTempDir('happier-current-external-agent-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    const executable = await writeExecutableShim({
      dir: pathDir,
      fileName: 'current-acme',
      contents: '#!/bin/sh\necho ok\n',
    });
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
    });
    getRuntimeRegistryState.mockReturnValue({
      activeRegistry: {
        contributes: {
          agentDefinitionsById: new Map([
            ['acme-agent', { runtimeSpec: externalRuntimeSpec('current-acme') }],
          ]),
        },
      },
    });

    expect(requireAgentCliLaunchSpec('acme-agent', {
      processEnv: { PATH: pathDir },
    })).toMatchObject({
      source: 'system',
      resolvedPath: executable,
    });
  });

  it('does not admit runtime metadata from a registry whose generation is no longer current', async () => {
    const root = await createTempDir('happier-stale-external-agent-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    await writeExecutableShim({
      dir: pathDir,
      fileName: 'stale-acme',
      contents: '#!/bin/sh\necho ok\n',
    });
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
    });
    getRuntimeRegistryState.mockReturnValue({
      activeRegistry: {
        contributes: {
          agentDefinitionsById: new Map([
            ['acme-agent', { runtimeSpec: externalRuntimeSpec('stale-acme') }],
          ]),
        },
      },
    });
    isRuntimeRegistryCurrent.mockReturnValue(false);

    expect(() => requireAgentCliLaunchSpec('acme-agent', {
      processEnv: { PATH: pathDir },
    })).toThrow("Missing agent CLI runtime metadata for 'acme-agent'");
  });
});
