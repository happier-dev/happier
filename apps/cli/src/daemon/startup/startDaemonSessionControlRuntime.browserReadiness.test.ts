import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';

import { createProductBrowserSidecarControlAdapterFactory } from '../browser/sidecar/productSource';
import type { SidecarBrowserBinaryCandidate } from '../browser/sidecar/binary';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('serves control during an installed-browser probe, keeps missing routes unavailable, and rejects a late adapter after retirement', async () => {
  const installedBrowser = createDeferred<SidecarBrowserBinaryCandidate | null>();
  const probeStarted = createDeferred();
  let browserPublished = false;
  const retryBrowser = createDeferred<SidecarBrowserBinaryCandidate | null>();
  const retryStarted = createDeferred();
  let probes = 0;
  const starter = createAttachedManagedRunFixture({ browserStartup: {
    onBrowserControlRoutesReady: () => { browserPublished = true; },
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
        sidecar: { enabled: true }, automation: { enabled: true } } },
    }) }),
    browserSidecarControlAdapterFactory: createProductBrowserSidecarControlAdapterFactory({
      // Installed-artifact discovery is the filesystem boundary. Keep the real
      // product source, feature gate, route owner and startup composition.
      resolveManagedCandidate: async () => {
        if (++probes === 1) {
          probeStarted.resolve(undefined);
          return await installedBrowser.promise;
        }
        retryStarted.resolve(undefined);
        return await retryBrowser.promise;
      },
    }),
  } });
  let cleanupCompletion: Promise<void> | undefined;
  const cleanup = () => cleanupCompletion ??= (async () => {
    installedBrowser.resolve(null);
    retryBrowser.resolve(null);
    await (await starter).cleanup();
  })();
  onTestFinished(cleanup);
  try {
    const [fixture] = await Promise.all([starter, probeStarted.promise]);
    expect(fixture.control?.agentRuntimeDaemonServices).toBeDefined();
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
    const initialRefresh = fixture.runtime.refreshBrowserRouteOwners();
    installedBrowser.resolve({ source: 'managedBrowserPackage', discoveryKind: 'managedRuntime', available: false });
    await initialRefresh;
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
    const refresh = fixture.runtime.refreshBrowserRouteOwners();
    await retryStarted.promise;
    expect(probes).toBe(2);
    await fixture.runtime.stopControlServer();
    retryBrowser.resolve({ source: 'managedBrowserPackage', discoveryKind: 'managedRuntime', available: true,
      executablePath: process.execPath, provenance: { origin: 'managed_package', pinnedVersion: '127.0.6533.88',
        channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } });
    await refresh;
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
  } finally {
    await cleanup();
  }
});
