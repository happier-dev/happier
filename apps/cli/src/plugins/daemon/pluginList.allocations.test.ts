import { Session } from 'node:inspector/promises';
import fastify from 'fastify';
import { expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createDaemonControlAuthGuard } from '@/daemon/controlAuth';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { registerDaemonPluginChangeRoutes } from './controlRoutes';
import { readCurrentDaemonPluginCatalogSnapshot, readCurrentDaemonPluginList } from './currentCatalog';

it('allocates no loopback transport bytes for a daemon-owned plugin list', async () => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
    manifest: createPluginManifestV2Fixture({ id: 'acme.list' }),
    files: { 'daemon.mjs': 'export function activate() {}' },
  }] });
  const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  const app = fastify();
  const inspector = new Session();
  try {
    environment.patch({ HAPPIER_HOME_DIR: fixture.happyHomeDir });
    reloadConfiguration();
    const catalog = { reloadController: fixture.controller, happyHomeDir: fixture.happyHomeDir };
    let recovered = false;
    fixture.controller.setRuntimeInitialization(Promise.resolve(), async () => {
      await Promise.resolve();
      recovered = true;
    });
    let failCatalog = false;
    let failPending = false;
    const requireCatalog = () => {
      if (failCatalog) throw new Error('Catalog fixture unavailable');
    };
    const service = {
      requestPluginChange: async () => { throw new Error('Unexpected mutation'); },
      decidePluginChange: async () => { throw new Error('Unexpected mutation'); },
      statusPluginChange: async () => ({ kind: 'expired' as const }),
      listPendingPluginChanges: async () => {
        if (failPending) throw new Error('Pending changes fixture unavailable');
        return { changes: [{ kind: 'applying' as const, pendingChangeId: 'pending-1' }] };
      },
      shutdown: async () => {},
    };
    const services = {
      readPluginList: async (display: 'summary' | 'full') => {
        requireCatalog();
        return readCurrentDaemonPluginList({ ...catalog, display });
      },
      listPendingPluginChanges: service.listPendingPluginChanges,
    };
    registerDaemonPluginChangeRoutes(app, {
      service, requireAuth: createDaemonControlAuthGuard('fixture-token'),
      recoverFailedAccountCensus: fixture.controller.recoverFailedAccountCensus,
      readCatalogSnapshot: async () => {
        requireCatalog();
        return readCurrentDaemonPluginCatalogSnapshot(catalog);
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing catalog HTTP listener');
    writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'fixture-token',
      startedAt: Date.now(), startedWithCliVersion: 'test' });

    const execute = (projection: 'summary' | 'full', inDaemon: boolean) => executePluginDevLoopAction(
      { actionId: 'plugins.list', input: projection === 'summary' ? { projection } : {} },
      inDaemon ? services : {},
    );
    for (const projection of ['summary', 'full'] as const) {
      const transported = await execute(projection, false);
      expect(transported).toMatchObject({
        ok: true, kind: 'plugins_list', plugins: expect.arrayContaining([expect.objectContaining({
          pluginId: 'acme.list', ...(projection === 'full' ? { contributions: expect.anything() } : {}),
        })]),
        pendingChanges: [{ kind: 'applying', pendingChangeId: 'pending-1' }],
      });
      if (projection === 'summary' && 'plugins' in transported) {
        expect(transported.plugins?.find(plugin => plugin.pluginId === 'acme.list')).not.toHaveProperty('contributions');
      }
      expect(recovered).toBe(true);
      recovered = false;
      const inDaemon = await execute(projection, true);
      expect(recovered).toBe(true);
      expect(inDaemon).toEqual(transported);
      expect(StrictJsonValueSchema.safeParse(inDaemon).success).toBe(true);
    }

    for (const fail of ['catalog', 'pending'] as const) {
      failCatalog = fail === 'catalog';
      failPending = fail === 'pending';
      const transported = await execute('full', false);
      expect(transported).toMatchObject({
        ok: false, kind: 'plugins_list', diagnostics: [{ code: 'daemon_unavailable' }],
      });
      expect(await execute('full', true)).toEqual(transported);
    }
    failCatalog = false;
    failPending = false;

    inspector.connect();
    const sample = async (inDaemon: boolean) => {
      await inspector.post('HeapProfiler.startSampling', {
        samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      const calls = 6;
      for (let index = 0; index < calls; index++) await execute('full', inDaemon);
      const { profile } = await inspector.post('HeapProfiler.stopSampling');
      let transportBytes = 0;
      const visit = (node: typeof profile.head, inTransport: boolean) => {
        const transport = inTransport || node.callFrame.functionName === 'daemonPost';
        if (transport) transportBytes += node.selfSize;
        for (const child of node.children) visit(child, transport);
      };
      visit(profile.head, false);
      return {
        sampledBytesPerCall: profile.samples.reduce((sum, allocation) => sum + allocation.size, 0) / calls,
        transportBytesPerCall: transportBytes / calls,
      };
    };
    const transported = await sample(false);
    const inDaemon = await sample(true);
    console.info(JSON.stringify({ transported, inDaemon }));
    expect(transported.transportBytesPerCall).toBeGreaterThan(0);
    expect(inDaemon.transportBytesPerCall).toBe(0);
    expect(inDaemon.sampledBytesPerCall).toBeLessThan(transported.sampledBytesPerCall);
  } finally {
    inspector.disconnect();
    await app.close();
    await clearDaemonStateForTestTeardown();
    environment.restore();
    reloadConfiguration();
    await fixture.dispose();
  }
}, 180_000);
