import { expect, it, vi } from 'vitest';
import axios from 'axios';

import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { readDaemonState } from '@/persistence';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

it('recovers a cold Account plugin census on catalog demand with the same connected daemon', async () => {
  const get = axios.get;
  const post = axios.post;
  let homeAvailable = false;
  let failedCensusReads = 0;
  const unavailable = () => Object.assign(new axios.AxiosError('Fixture Home unavailable'), {
    response: { status: 503, data: { error: 'database_connection_unavailable' } },
  });
  const settings = vi.spyOn(axios, 'get').mockImplementation((url, options) => {
    if (!homeAvailable && new URL(String(url)).pathname === '/v2/account/settings') {
      return Promise.reject(unavailable());
    }
    return get(url, options);
  });
  const census = vi.spyOn(axios, 'post').mockImplementation((url, body, options) => {
    if (!homeAvailable && String(url).endsWith('/intents/list')) {
      failedCensusReads++;
      return Promise.reject(unavailable());
    }
    return post(url, body, options);
  });
  let fixture: Awaited<ReturnType<typeof startInstalledDaemonFixture>> | undefined;
  try {
    fixture = await startInstalledDaemonFixture();
    const daemon = await readDaemonState();
    expect(failedCensusReads).toBeGreaterThan(0);
    const unavailableCatalog = await readDaemonPluginCatalog();
    expect(unavailableCatalog).toMatchObject({
      kind: 'available',
      plugins: expect.arrayContaining([expect.objectContaining({
        pluginId: 'happier.agent.codex',
        enabled: false,
        contributionIntrospection: expect.objectContaining({ diagnostics: expect.arrayContaining([
          expect.objectContaining({ data: expect.objectContaining({
            details: expect.objectContaining({ failureCause: expect.objectContaining({
              errorCode: 'database_connection_unavailable', httpStatus: 503, phase: 'plugins.account_census',
            }) }),
          }) }),
        ]) }),
      })]),
    });
    const failedLease = await pluginReloadController.acquireExecutableRuntimeRegistry();
    try {
      expect(failedLease?.registry.contributes.pluginEnablementById?.['happier.agent.codex'])
        .toMatchObject({ enabled: false, unavailableCode: 'plugin_account_census_failed' });
    } finally {
      await failedLease?.release();
    }
    homeAvailable = true;
    expect(await readDaemonPluginCatalog()).toMatchObject({
      kind: 'available',
      plugins: expect.arrayContaining([expect.objectContaining({ pluginId: 'happier.agent.codex', enabled: true })]),
    });
    const recoveredLease = pluginReloadController.tryAcquireRuntimeRegistry();
    try {
      expect(recoveredLease?.registry.contributes.pluginEnablementById?.['happier.agent.codex'])
        .toMatchObject({ enabled: true });
    } finally {
      await recoveredLease?.release();
    }
    expect(daemon?.runtimeId).toBeTruthy();
    expect((await readDaemonState())?.runtimeId).toBe(daemon?.runtimeId);
  } finally {
    settings.mockRestore();
    census.mockRestore();
    await fixture?.stop();
  }
}, 120_000);
