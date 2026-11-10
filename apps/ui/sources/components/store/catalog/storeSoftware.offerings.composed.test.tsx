import { expect, it } from 'vitest';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { flushHookEffects, renderHook } from '@/dev/testkit';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { replacePluginAccountAvailabilityProjection } =
  await import('@/sync/domains/plugins/availability/projection');

it('names Software and attached recipes from Account declarations without requiring Machine support', async () => {
  const bridge = await loadSyncSingletonForTests();
  const http = createHomeHubArtifactHttpBoundary('viewer');
  let machineReads = 0;
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://preset-offerings.test',
    accountId: 'viewer',
    request: (url, init) => {
      if (new URL(String(url)).pathname.startsWith('/v1/machines'))
        machineReads++;
      return http.request(url, init);
    },
  });
  const previous = storage.getState();
  const account = await captureLazyActionAccountContext(connection.home.id);
  const disposeLoader = await installRealActionExecutorModuleLoader();
  const { useSoftwareOptions, useMachineSetupRecipeOptions } = await import('./storeSoftware');
  const { machineSetupItemPresentation } = await import('@/components/settings/machines/managed/machineSetupItems');
  try {
    storage.setState({ machines: {}, sessions: {} });
    const { PLUGIN_MANIFEST } =
      await import('../../../../../../packages/plugins/machine-recipes/src/manifest');
    // The default UI test config replaces the bundled byte inventory with an empty asset boundary;
    // the real authored declaration arrives through the Account response boundary instead.
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
      availabilityCursor: 1,
      hostingCapability: { enabled: false },
      intent: {
        pluginId: PLUGIN_MANIFEST.id,
        desiredVersion: PLUGIN_MANIFEST.version,
        enabled: true,
        offlineUiHosting: 'disabled',
        writableCollections: [],
        revision: 'intent-1',
      },
      release: {
        ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: PLUGIN_MANIFEST,
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
          archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
          resources: [],
        },
      },
      packageAssets: [],
      uiArtifacts: [],
    });
    replacePluginAccountAvailabilityProjection({
      scope: account.accountLifetime.scope,
      snapshot: {
        availabilityCursor: 1,
        intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }],
        materializations: [],
        snapshots: [],
      },
    });
    machineReads = 0;
    const ref = { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' };
    const target = { scope: account.accountLifetime.scope, machine: null };
    const attachedTarget = { scope: account.accountLifetime.scope, machine: { serverIdentityId: 'srv_unsupported', machineId: 'unsupported-machine' } };
    const mounted = await renderHook(
      (props: Readonly<{ presented: boolean }>) =>
        ({ software: useSoftwareOptions(target, { presented: props.presented }),
          recipe: useMachineSetupRecipeOptions(attachedTarget, { presented: props.presented }) }),
      { initialProps: { presented: true } },
    );
    try {
      for (
        let attempt = 0;
        attempt < 50 && mounted.getCurrent().recipe.state.status !== 'ready';
        attempt++
      )
        await flushHookEffects();
      expect(mounted.getCurrent().recipe.state).toMatchObject({
        status: 'ready',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: {
              pluginId: 'happier.machine.recipes',
              recipeId: 'google-chrome',
              revision: '1',
            },
            label: 'Google Chrome',
          }),
        ]),
      });
      expect(mounted.getCurrent().software.state.status).toBe('ready');
      const ready = mounted.getCurrent().recipe.state;
      const presentation = machineSetupItemPresentation({ kind: 'softwareRecipe', selection: { ref, inputs: {} } }, ready.options);
      expect(presentation).toMatchObject({ title: 'Google Chrome', icon: expect.any(String) });
      await mounted.rerender({ presented: true });
      await flushHookEffects();
      expect(mounted.getCurrent().recipe.state).toBe(ready);
      expect(machineReads).toBe(0);
    } finally {
      await mounted.unmount();
    }
  } finally {
    disposeLoader();
    account.dispose();
    storage.setState(previous, true);
    await connection.dispose();
    bridge.dispose();
  }
});
