import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES, type ScmBackendContribution } from '@happier-dev/protocol';
import type { ScmBackendRuntimeRegistration } from '@happier-dev/plugin-sdk';
import { reloadConfiguration } from '@/configuration';
import type { ResolvedScmBackendContribution } from '@/plugins/projection/registry/types';
import { createPluginStateStore } from '@/plugins/store/state';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { createScmBackendRegistry } from './registry';
import { runScmRoute } from './rpc/dispatch';
import type { ScmBackendPluginRuntimeRegistry } from './pluginBackends/runtimeRegistry';
import { createScmBackendCatalog } from './scmBackendCatalog';

function createPluginBackendCapabilities(): ScmBackendContribution['capabilities'] {
  const supported = { support: 'supported' } as const;
  const unsupported = { support: 'unsupported', reason: 'not_implemented' } as const;

  return {
    detection: {
      repository: supported,
      repoIdentity: unsupported,
      ignoredPath: unsupported,
      repoMode: supported,
      executable: supported,
    },
    read: {
      status: supported,
      diffFile: unsupported,
      diffCommit: unsupported,
      log: unsupported,
      branches: unsupported,
      stash: unsupported,
      defaultBranch: unsupported,
      hostingProvider: unsupported,
      pullRequestStatus: unsupported,
    },
    changeSet: {
      model: 'working-copy',
      diffAreas: ['pending'],
      include: unsupported,
      exclude: unsupported,
      discard: unsupported,
    },
    commit: {
      create: unsupported,
      pathSelection: unsupported,
      lineSelection: unsupported,
      backout: unsupported,
    },
    remote: {
      read: unsupported,
      add: unsupported,
      setUrl: unsupported,
      remove: unsupported,
      fetch: unsupported,
      pull: unsupported,
      push: unsupported,
      publish: unsupported,
    },
    branch: {
      list: unsupported,
      create: unsupported,
      checkout: unsupported,
      merge: unsupported,
      rebase: unsupported,
      operationControl: unsupported,
    },
    worktree: {
      create: unsupported,
      remove: unsupported,
      prune: unsupported,
      prepare: unsupported,
    },
    lifecycle: {
      init: unsupported,
      clone: unsupported,
      publish: unsupported,
      identityRediscovery: unsupported,
      removeIndexLock: unsupported,
    },
    hosting: {
      providerDetection: unsupported,
      repositoryPublishTargets: unsupported,
      repositoryPublish: unsupported,
      pullRequestRead: unsupported,
      pullRequestStatus: unsupported,
      pullRequestCreate: unsupported,
      pullRequestReuse: unsupported,
      pullRequestCheckout: unsupported,
      pullRequestPrepareWorktree: unsupported,
      pullRequestRunStacked: unsupported,
    },
    checkpoints: {
      capture: unsupported,
      aliasFinalize: unsupported,
      diff: unsupported,
      cleanup: unsupported,
      backup: unsupported,
      rollbackApply: unsupported,
    },
    workspaceIntegration: {
      inspectLocation: unsupported,
      checkoutMaterialization: unsupported,
      workspaceTransfer: unsupported,
      exportPortability: unsupported,
      portablePathClassification: unsupported,
    },
    tooling: {
      systemCliResolution: supported,
      managedCliResolution: supported,
      binarySafe: supported,
    },
    freshness: {
      observed: unsupported,
      expiry: unsupported,
    },
  };
}

function createPluginBackendDefinition(id: string): ScmBackendContribution {
  return {
    id,
    displayName: 'Acme VCS',
    repoModes: ['.git'],
    detection: { rootMarkers: ['.acme'] },
    capabilities: createPluginBackendCapabilities(),
    installableDependencies: ['dep.acme-vcs'],
    tooling: {
      commands: [{ installableKey: 'dep.acme-vcs', command: 'acme' }],
      systemFirst: true,
      managedFallback: true,
    },
    safetyConstraints: {
      mutatesWorkingTree: false,
      requiresUserConfirmationForDestructiveWrites: false,
    },
  };
}

function createRuntimeScmBackendContribution(definition: ScmBackendContribution): ResolvedScmBackendContribution {
  return {
    id: definition.id,
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.scm.backend',
    manifestPath: '/plugins/acme-scm/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:acme',
    daemonEntryPath: '/plugins/acme-scm/daemon.mjs',
    definition,
  };
}

async function writeScmBackendPlugin(input: Readonly<{
  pluginRoot: string;
  pluginId: string;
  backendDefinition: ScmBackendContribution;
}>): Promise<void> {
  const manifestDir = join(input.pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(input.pluginRoot, 'daemon.mjs'),
    [
      'export async function activate(api) {',
      '  api.registerScmBackend({',
      `    id: ${JSON.stringify(input.backendDefinition.id)},`,
      '    handlers: {',
      '      detection: {',
      '        detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: ".git" }),',
      '      },',
      '      read: {',
      '        statusSnapshot: async () => ({ success: true }),',
      '      },',
      '    },',
      '  });',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: input.pluginId,
      version: '1.0.0',
      displayName: 'Acme SCM Backend',
      description: 'SCM backend bridge regression fixture',
      engines: { happier: '^0.2.0' },
      uses: ['scmBackends'],
      activationEvents: [`onScmProvider:${input.backendDefinition.id}`],
      entrypoints: {
        main: './daemon.mjs',
      },
      permissions: { required: [], optional: [] },
      contributes: {
        scmBackends: [input.backendDefinition],
      },
    }),
    'utf8',
  );
}

async function enableLocalPlugin(input: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  pluginId: string;
}>): Promise<void> {
  const store = createPluginStateStore({ happyHomeDir: input.happyHomeDir });
  await store.write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [input.pluginId]: {
        source: {
          kind: 'path',
          locator: input.pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: input.pluginRoot,
          manifestPath: join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: {
          status: 'unknown',
          diagnostics: [],
        },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          manifestDigest: null,
          installedPath: null,
        },
        state: {
          enabled: true,
        },
      },
    },
  });
}

describe('scmBackendCatalog plugin backends', () => {
  it('projects activated plugin SCM backends into the catalog path used by SCM RPC routing', async () => {
    const definition = createPluginBackendDefinition('acme-vcs');
    const registration: ScmBackendRuntimeRegistration = {
      id: 'acme-vcs',
      handlers: {
        detection: {
          detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
        },
        read: {
          statusSnapshot: async () => ({ success: true }),
        },
      },
    };
    const pluginRuntimeRegistry: ScmBackendPluginRuntimeRegistry = {
      contributes: {
        scmBackends: [createRuntimeScmBackendContribution(definition)],
      },
      scmBackendsById: new Map([
        ['acme-vcs', { pluginId: 'acme.scm.backend', registration }],
      ]),
    };
    const backends = createScmBackendCatalog({ pluginRuntimeRegistry });
    const registry = createScmBackendRegistry(backends);

    const response = await runScmRoute<
      { cwd: string; backendPreference: { kind: 'prefer'; backendId: string } },
      { success: boolean; errorCode?: string; backendId?: string }
    >({
      request: {
        cwd: '/repo',
        backendPreference: { kind: 'prefer', backendId: 'acme-vcs' },
      },
      workingDirectory: '/repo',
      onNonRepository: () => ({
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
      }),
      registry,
      runWithBackend: async ({ context, selection }) => {
        const status = await selection.backend.statusSnapshot({ context, request: {} });
        return {
          success: status.success,
          backendId: selection.backend.id,
        };
      },
    });

    expect(response).toEqual({
      success: true,
      backendId: 'acme-vcs',
    });
  });

  it('loads manifest-declared and activation-registered SCM backends through the default RPC catalog', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-scm-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-scm-plugin-root-'));
    const pluginId = 'acme.scm.backend';
    const backendDefinition = createPluginBackendDefinition('acme-vcs');
    await writeScmBackendPlugin({ pluginRoot, pluginId, backendDefinition });
    await enableLocalPlugin({ happyHomeDir, pluginRoot, pluginId });

    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    try {
      const response = await runScmRoute<
        { cwd: string; backendPreference: { kind: 'prefer'; backendId: string } },
        { success: boolean; errorCode?: string; backendId?: string }
      >({
        request: {
          cwd: '/repo',
          backendPreference: { kind: 'prefer', backendId: 'acme-vcs' },
        },
        workingDirectory: '/repo',
        onNonRepository: () => ({
          success: false,
          errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
        }),
        runWithBackend: async ({ context, selection }) => {
          const status = await selection.backend.statusSnapshot({ context, request: {} });
          return {
            success: status.success,
            backendId: selection.backend.id,
          };
        },
      });

      expect(response).toEqual({
        success: true,
        backendId: 'acme-vcs',
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });
});
