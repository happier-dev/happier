import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2, type ParsedPluginManifestV2 } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
  PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { projectInstalledDaemonPluginVoiceModelPackCatalogV1 } from './pluginModelPackCatalog.js';
import { manifest as publicAuthoringManifest } from '../../../../../packages/plugin-sdk/examples/public-authoring/index';

const pluginId = 'examples.public-sdk-review-assistant';
const pluginVersion = '0.1.0';
const modelOrigin = 'https://models.example.com';
const publicAuthoringEntry = new URL('../../../../../packages/plugin-sdk/examples/public-authoring/index.ts', import.meta.url);

const daemonHost = {
  executionHost: 'daemon' as const,
  hostVersion: '1.5.0',
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  runtimeFamilies: { sherpa_zipformer_streaming: { abiVersion: 1 } },
};

async function readPublicAuthoringManifest(): Promise<ParsedPluginManifestV2> {
  // Load the real example with the test graph so cold SDK compilation does not
  // consume the fixture operation's test deadline.
  const ingested = ingestPluginManifestV2(publicAuthoringManifest);
  expect(ingested.ok, ingested.ok ? undefined : JSON.stringify(ingested.diagnostics)).toBe(true);
  if (!ingested.ok) throw new Error('public_authoring_manifest_ingestion_failed');
  return ingested.manifest;
}

async function projectLoadedPlugins(
  happyHomeDir: string,
  controller: PluginReloadController,
) {
  const lease = controller.tryAcquireRuntimeRegistry();
  if (!lease) throw new Error('Expected the development authoring owner to publish a serving registry');
  try {
    const registry = lease.registry.contributes;
    const projection = buildPluginProjectionV2({ registry, generation: controller.getState().generation });
    if (!lease.registry.readPluginSourceCustody) throw new Error('Expected admitted plugin source custody reader');
    const readSourceCustody = lease.registry.readPluginSourceCustody;
    const currentPluginRuntimes = lease.registry.pluginFinalPolicyCurrentRuntimesById;
    if (!currentPluginRuntimes) throw new Error('Expected admitted plugin policy facts');
    const catalog = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: await readInstalledPluginCatalog({ happyHomeDir }),
      currentPluginRuntimes,
      resolvePluginSourceCustody: readSourceCustody,
      host: daemonHost,
    });
    return { registry, projection, catalog };
  } finally {
    await lease.release();
  }
}

async function installPublicAuthoringFixture() {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-authoring-home-'));
  const controllerIdentity = { machineId: 'voice-pack-machine', installationId: 'voice-pack-installation' };
  // Managed-resource removal admission crosses Home HTTP even for a local
  // development plugin. Keep that transport real with an empty resource census.
  const home = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    expect(PluginAvailabilityIntentReadActionInputV1Schema.parse(JSON.parse(body))).toMatchObject({
      pluginId, includeManagedResources: true, controller: controllerIdentity, homeId: 'voice-pack-home',
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(PluginAvailabilityIntentReadActionOutputV1Schema.parse({
      availabilityCursor: 0, hostingCapability: { enabled: false }, intent: null, release: null,
      uiArtifacts: [], packageAssets: [], managedResources: [], managedResourcesReviewed: true,
    })));
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const homeAddress = home.address();
  if (!homeAddress || typeof homeAddress === 'string') throw new Error('Expected fixture Home address');
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  let owner: ReturnType<typeof createDaemonPluginRuntimeOwner> | null = null;
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      await owner?.changeService.shutdown();
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        try {
          await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
        } finally {
          await rm(happyHomeDir, { recursive: true, force: true });
        }
      }
    }
  }
  try {
    // Start with a genuinely published empty registry, then let the daemon's
    // development owner establish source trust, host-access approval and custody.
    runtime = await createAdmittedPluginRuntimeFixture({
      happyHomeDir,
      runtimeOptions: { pluginIds: [] },
    });
    const connectedAccounts = createPackedTestConnectedAccountsRuntime({
      happyHomeDir,
      pluginId,
      runtimeRegistry: runtime.controller,
    });
    owner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      managedResourcePreflight: {
        credentials: { token: 'voice-pack-account-token', encryption: null },
        serverUrl: `http://127.0.0.1:${homeAddress.port}`, homeId: 'voice-pack-home', controller: controllerIdentity,
      },
      reloadController: runtime.controller,
      connectedAccounts: connectedAccounts.owner,
      reconcileConnectedAccountPurposePublication: connectedAccounts.reconcileRegistryPublication,
    });
    await owner.initialize();
    const controlDevelopment = owner.changeService.controlPluginDevelopment;
    if (!controlDevelopment) throw new Error('Expected canonical development-root control owner');
    // Register the actual code-defined example. The single-file authoring path
    // resolves its real relative modules without package installation or a UI build.
    const registration = await controlDevelopment({
      kind: 'registerExplicit',
      rootPath: fileURLToPath(publicAuthoringEntry),
    });
    // Explicit source trust does not approve the example's host access. The
    // development control reports the pending installation review as unavailable
    // until the present-user decision below admits that exact candidate.
    expect(
      registration,
      registration.kind === 'failed' ? `${registration.code}: ${registration.message}` : undefined,
    ).toMatchObject({ kind: 'failed', code: 'plugin_dev_reviewRequired' });
    const pending = await owner.changeService.listPendingPluginChanges();
    expect(pending.changes).toHaveLength(1);
    const review = pending.changes[0];
    if (!review || review.kind !== 'reviewRequired' || review.reviewKind !== 'installation') {
      throw new Error('Expected the public example host-access installation review');
    }
    const approval = await owner.changeService.decidePluginChange({
      pendingChangeId: review.pendingChangeId,
      decision: 'installAndTrust',
      optionalSelections: [],
    });
    expect(
      approval,
      approval.kind === 'failed' ? `${approval.code}: ${approval.message}` : undefined,
    ).toMatchObject({ kind: 'committed', pluginId });
    const sourceCustody = runtime.controller.readCurrentPluginSourceCustody?.(pluginId);
    expect(sourceCustody).toMatchObject({ kind: 'development' });
    expect(runtime.controller.readCurrentPluginOccurrenceId?.(pluginId)).toEqual(expect.any(String));
    const changeService = owner.changeService;
    return {
      happyHomeDir,
      controller: runtime.controller,
      async setEnabled(enabled: boolean) {
        const result = await changeService.requestPluginChange({
          kind: enabled ? 'enable' : 'disable',
          pluginId,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'committed', pluginId });
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Public authoring fixture preparation and cleanup failed');
    }
    throw error;
  }
}

describe('public declarative voice model-pack authoring integration fixture', () => {
  it('flows cold-JSON settings and a model pack to the selected-daemon catalog without mixing executable Voice runtime state into the pack row', async () => {
    const manifest = await readPublicAuthoringManifest();
    const fixture = await installPublicAuthoringFixture();
    try {
      const enabledLoad = await loadInstalledPlugins({ happyHomeDir: fixture.happyHomeDir });
      const enabled = await projectLoadedPlugins(fixture.happyHomeDir, fixture.controller);
      const qualifiedPackId = `${pluginId}/english-small`;
      const qualifiedSettingsId = `${pluginId}/preferences`;
      const qualifiedVoiceProviderId = `${pluginId}/credentialed-browser`;

      expect(manifest.contributes.settings).toEqual([
        expect.objectContaining({ id: 'preferences', scope: 'account' }),
      ]);
      expect(enabledLoad.loadedPlugins).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            contributes: expect.objectContaining({
              settings: [expect.objectContaining({ id: 'preferences', scope: 'account' })],
            }),
          }),
        }),
      ]);
      expect(enabled.registry.settings
        ?.filter(entry => entry.pluginId === pluginId)
        .map(entry => entry.definition)).toEqual(manifest.contributes.settings);
      expect(enabled.projection.settingsById).toHaveProperty(qualifiedSettingsId);
      expect(enabled.projection.familiesById.voiceModelPacks?.entriesById).toHaveProperty(qualifiedPackId);
      expect(enabled.catalog).toEqual([
        expect.objectContaining({
          status: 'available',
          installable: true,
          loadable: false,
          identity: { pluginId, packId: 'english-small' },
          sourceLabel: { pluginId, pluginVersion },
        }),
      ]);

      expect(manifest.contributes.voiceProviders).toContainEqual(expect.objectContaining({
        id: 'credentialed-browser',
      }));
      expect(enabled.projection.familiesById.voiceProviders?.entriesById).toHaveProperty(
        qualifiedVoiceProviderId,
      );
      expect(enabled.catalog[0]).not.toHaveProperty('register');
      expect(enabled.catalog[0]).not.toHaveProperty('transport');
      expect(enabled.catalog[0]).not.toHaveProperty('parser');
      expect(enabled.catalog[0]).not.toHaveProperty('server');

      await fixture.setEnabled(false);
      const disabled = await projectLoadedPlugins(fixture.happyHomeDir, fixture.controller);

      expect(disabled.projection.settingsById).not.toHaveProperty(qualifiedSettingsId);
      expect(disabled.projection.familiesById.voiceModelPacks?.entriesById ?? {}).not.toHaveProperty(qualifiedPackId);
      expect(disabled.projection.familiesById.voiceProviders?.entriesById ?? {}).not.toHaveProperty(
        qualifiedVoiceProviderId,
      );
      expect(disabled.catalog).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
