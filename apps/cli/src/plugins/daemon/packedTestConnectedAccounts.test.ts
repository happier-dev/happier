import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';

const pluginId = 'acme.connected-accounts-conformance';
const consumer = { pluginId, localId: 'verify' } as const;
const purpose = { consumer, purpose: 'fixed' } as const;
const service = { pluginId, localId: 'vault' } as const;
const temporaryRoots: string[] = [];

function registryWithFixedPurpose(): ResolvedContributionRegistry {
  const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: pluginId,
    hostAccess: {
      required: [{
        id: 'fixed',
        capability: 'connectedAccounts',
        reason: 'Use the fixed account',
        scope: {
          serviceRefs: ['vault'],
          operations: ['select', 'use'],
        },
      }],
      optional: [],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'vault',
        title: 'Acme Vault',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthDeviceCode',
            outcomeReconciliation: 'providerCheck',
          }],
        },
      }],
      actions: [{
        id: consumer.localId,
        title: 'Verify',
        scopes: ['global'],
        surfaces: ['cli'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
        hostAccess: ['fixed'],
      }],
    },
  }));
  if (!manifest) throw new Error('Expected a canonical packed Connected Accounts manifest');
  return {
    ...emptyRegistry(),
    activationTargets: [{
      pluginId,
      manifestPath: '/fixture/.happier-plugin/plugin.json',
      manifestDigest: 'fixture-manifest',
      daemonEntryPath: null,
      manifest,
      source: { kind: 'path' },
      provenance: 'external',
      sourceSpec: {
        kind: 'path',
        locator: '/fixture',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    }],
  };
}

function emptyRegistry(): ResolvedContributionRegistry {
  return {
    agents: [],
        providers: [],
    actions: [],
    tools: [],
    commands: [],
    resources: [],
    activationTargets: [],
    actionsById: new Map(),
    toolsById: new Map(),
    commandsById: new Map(),
    resourcesById: new Map(),
        catalogEntriesById: {},
    agentDefinitionsById: new Map(),
        providersByContributionKey: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('packed Connected Accounts runtime boundary', () => {
  it('contracts removed purposes through the real binding owner and does not resurrect them when re-added', async () => {
    expect(ConnectedServiceIdSchema.safeParse(service.localId).success).toBe(false);
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-connected-accounts-'));
    temporaryRoots.push(happyHomeDir);
    const runtime = createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId });
    const signal = new AbortController().signal;

    await runtime.owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent: () => undefined,
      reason: 'Select the fixed account',
      signal,
    });
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.not.toBeNull();

    let removedPublished = false;
    await runtime.reconcileRegistryPublication({
      previous: registryWithFixedPurpose(),
      candidate: emptyRegistry(),
      resolveOptionalAccess: () => [],
      publish: () => {
        removedPublished = true;
      },
    });
    expect(removedPublished).toBe(true);
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.toBeNull();

    await runtime.reconcileRegistryPublication({
      previous: emptyRegistry(),
      candidate: registryWithFixedPurpose(),
      resolveOptionalAccess: () => [],
      publish: () => undefined,
    });
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.toBeNull();
  });
});
