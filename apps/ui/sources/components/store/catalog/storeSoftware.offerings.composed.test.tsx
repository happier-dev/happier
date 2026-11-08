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

it('names Account Software with no Machine: an Account target with `machine: null` reads the inert offerings once', async () => {
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
  const { useSoftwareOptions } = await import('./storeSoftware');
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
    const target = { scope: account.accountLifetime.scope, machine: null };
    const mounted = await renderHook(
      (props: Readonly<{ presented: boolean }>) =>
        useSoftwareOptions(target, { presented: props.presented }),
      { initialProps: { presented: true } },
    );
    try {
      for (
        let attempt = 0;
        attempt < 50 && mounted.getCurrent().state.status !== 'ready';
        attempt++
      )
        await flushHookEffects();
      expect(mounted.getCurrent().state).toMatchObject({
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
      const ready = mounted.getCurrent().state;
      await mounted.rerender({ presented: true });
      await flushHookEffects();
      expect(mounted.getCurrent().state).toBe(ready);
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
