import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import * as protocol from '../../index.js';

function readSchemaExport(name: string): z.ZodTypeAny | undefined {
  const value = (protocol as Record<string, unknown>)[name];
  return value && typeof value === 'object' && 'safeParse' in value
    ? value as z.ZodTypeAny
    : undefined;
}

function createGroupedCapabilities() {
  const supported = { support: 'supported' };
  const unsupported = { support: 'unsupported', reason: 'not_implemented' };

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

describe('SCM backend plugin contribution schema', () => {
  it('accepts a static SCM backend descriptor without agent provider semantics', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.scm.backend',
      version: '1.0.0',
      displayName: 'Acme SCM Backend',
      engines: { happier: '^1.0.0' },
      uses: ['scmBackends'],
      entrypoints: { main: './daemon.js' },
      contributes: {
        scmBackends: [
          {
            id: 'acme-vcs',
            displayName: 'Acme VCS',
            repoModes: ['.git'],
            detection: {
              rootMarkers: ['.acme'],
            },
            capabilities: createGroupedCapabilities(),
            installableDependencies: ['dep.acme-vcs'],
            tooling: {
              commands: [
                {
                  installableKey: 'dep.acme-vcs',
                  command: 'acme',
                },
              ],
              systemFirst: true,
              managedFallback: true,
            },
            safetyConstraints: {
              mutatesWorkingTree: true,
              requiresUserConfirmationForDestructiveWrites: true,
            },
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.scmBackends).toEqual([
      expect.objectContaining({
        id: 'acme-vcs',
        displayName: 'Acme VCS',
        capabilities: expect.objectContaining({
          workspaceIntegration: expect.any(Object),
        }),
      }),
    ]);
    expect(parsed.contributes.agents).toEqual([]);
    expect('backends' in parsed.contributes).toBe(false);
  });

  it('rejects stale sourceController vocabulary in public backend descriptors', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const result = manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.scm.backend',
      version: '1.0.0',
      displayName: 'Acme SCM Backend',
      engines: { happier: '^1.0.0' },
      uses: ['scmBackends'],
      entrypoints: { main: './daemon.js' },
      contributes: {
        scmBackends: [
          {
            id: 'acme-vcs',
            displayName: 'Acme VCS',
            repoModes: ['.git'],
            detection: { rootMarkers: ['.acme'] },
            capabilities: createGroupedCapabilities(),
            sourceController: {},
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(result.success).toBe(false);
  });
});
