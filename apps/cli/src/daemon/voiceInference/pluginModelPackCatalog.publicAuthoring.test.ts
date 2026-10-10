import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2, type ParsedPluginManifestV2 } from '@happier-dev/protocol';

import {
  loadInstalledPlugins,
  type LoadInstalledPluginsResult,
} from '@/plugins/discovery/load/installed';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { projectDaemonPluginVoiceModelPackCatalogV1 } from './pluginModelPackCatalog.js';

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
  // This example is code-defined. Consume its canonical evaluated entrypoint;
  // a handwritten source manifest would create a second authority beside
  // `definePlugin(publicAuthoringDefinition)`.
  const publicAuthoringModule = await import(
    publicAuthoringEntry.href
  ) as Readonly<{ manifest: unknown }>;
  const ingested = ingestPluginManifestV2(publicAuthoringModule.manifest);
  expect(ingested.ok, ingested.ok ? undefined : JSON.stringify(ingested.diagnostics)).toBe(true);
  if (!ingested.ok) throw new Error('public_authoring_manifest_ingestion_failed');
  return ingested.manifest;
}

async function projectLoadedPlugins(
  loadResult: LoadInstalledPluginsResult,
  controller: PluginReloadController,
  grantedNetworkOrigins: readonly string[] = [modelOrigin],
) {
  const lease = controller.tryAcquireRuntimeRegistry();
  if (!lease) throw new Error('Expected the development authoring owner to publish a serving registry');
  try {
    const registry = lease.registry.contributes;
    const projection = buildPluginProjectionV2({ registry, generation: controller.getState().generation });
    if (!lease.registry.readPluginSourceCustody) throw new Error('Expected admitted plugin source custody reader');
    const readSourceCustody = lease.registry.readPluginSourceCustody;
    const catalog = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: loadResult.loadedPlugins.map((plugin) => {
        const sourceCustody = readSourceCustody(plugin.pluginId);
        if (sourceCustody?.kind !== 'development') {
          throw new Error('Expected admitted linked public authoring development source custody');
        }
        return {
          pluginId: plugin.pluginId,
          pluginVersion: plugin.manifest.version,
          artifactBinding: { kind: 'materialization' as const, sourceCustody },
          enabled: true,
          authorization: { outcome: 'visible' as const, code: 'plugin_final_available' as const, requiresCurrentIntent: false },
          grantedNetworkOrigins,
          contributions: (registry.voiceModelPacks ?? [])
            .filter((entry) => entry.pluginId === plugin.pluginId)
            .map((entry) => entry.definition),
        };
      }),
      host: daemonHost,
    });
    return { registry, projection, catalog };
  } finally {
    await lease.release();
  }
}

async function installPublicAuthoringFixture() {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-authoring-home-'));
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
        await rm(happyHomeDir, { recursive: true, force: true });
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
        await expect(changeService.requestPluginChange({
          kind: enabled ? 'enable' : 'disable',
          pluginId,
        })).resolves.toMatchObject({ kind: 'committed', pluginId });
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
      const enabled = await projectLoadedPlugins(enabledLoad, fixture.controller);
      const ungranted = await projectLoadedPlugins(enabledLoad, fixture.controller, []);
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
      expect(ungranted.catalog).toEqual([
        expect.objectContaining({
          status: 'blocked',
          reason: 'network_origin_not_granted',
          installable: false,
          loadable: false,
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
      const disabled = await projectLoadedPlugins(await loadInstalledPlugins({ happyHomeDir: fixture.happyHomeDir }), fixture.controller);

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
