import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeExecutableShim } from '../../../testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '../../../testkit/fs/tempDir';

const { getResolvedContributionRegistry, getRuntimeRegistryState, isRuntimeRegistryCurrent } = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getRuntimeRegistryState: vi.fn<() => { activeRegistry: object | null }>(() => ({ activeRegistry: null })),
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

import { createPluginAgentCliReadinessService } from './agents';

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

describe('createPluginAgentCliReadinessService external Agent readiness', () => {
  it('reports an installed external Agent only through its current declared runtime metadata', async () => {
    const root = await createTempDir('happier-external-agent-readiness-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    await writeExecutableShim({
      dir: pathDir,
      fileName: 'acme-cli',
      contents: '#!/bin/sh\necho ready\n',
    });
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme-agent', { runtimeSpec: externalRuntimeSpec('acme-cli') }],
      ]),
    });

    const result = await createPluginAgentCliReadinessService({
      processEnv: { PATH: pathDir },
    }).checkReadiness({
      candidates: ['acme-agent'],
      requirement: 'any',
    });

    expect(result).toEqual({ launchable: [{ agentId: 'acme-agent' }] });
  });

  it('fails closed when an external Agent has no current runtime metadata', async () => {
    getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
    });

    const result = await createPluginAgentCliReadinessService({
      processEnv: { PATH: '' },
    }).checkReadiness({
      candidates: ['acme-agent'],
      requirement: 'any',
    });

    expect(result).toEqual({ launchable: [] });
  });
});
