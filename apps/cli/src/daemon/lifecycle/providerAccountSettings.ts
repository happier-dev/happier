import type { ApiMachineClient } from '@/api/apiMachine';
import { isDeepStrictEqual } from 'node:util';

import { AGENTS } from '@/backends/catalog';
import packageJson from '../../../package.json';
import { subscribeProviderAccountSettingsMaterializations } from './providerAccountSettingsMaterializations';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export function createProviderAccountSettingsController(params: Readonly<{
  scopeKey: string;
  processEnv: NodeJS.ProcessEnv;
  activeServerDir: string;
  apiMachine: Pick<ApiMachineClient, 'updateDaemonState'>;
  onError: (error: unknown) => void;
}>) {
  let stopped = false;
  let tail = Promise.resolve();
  const refresh = (): Promise<void> => {
    const run = tail.then(async () => {
      const snapshot = getActiveAccountSettingsSnapshot();
      if (stopped || !snapshot || snapshot.scopeKey !== params.scopeKey) return;
      const reports: Record<string, Readonly<Record<string, unknown>>> = {};
      for (const agent of Object.values(AGENTS)) {
        if (!agent?.applyAccountSettings) continue;
        if (stopped) return;
        try {
          reports[agent.id] = await agent.applyAccountSettings({
            accountSettings: snapshot.settings,
            processEnv: params.processEnv,
            activeServerDir: params.activeServerDir,
          });
        } catch (error) {
          params.onError(error);
          reports[agent.id] = { status: 'error', reason: 'provider_settings_failed' };
        }
      }
      if (stopped || Object.keys(reports).length === 0) return;
      await params.apiMachine.updateDaemonState((state) => {
        const source = typeof state?.startedAt === 'number' && Number.isFinite(state.startedAt)
          ? { pid: process.pid, cliVersion: packageJson.version, startedAt: state.startedAt }
          : undefined;
        if (state
          && isDeepStrictEqual(state.providerSettingsV1, reports)
          && isDeepStrictEqual(state.providerSettingsSourceV1, source)) return state;
        return {
          ...state,
          status: state?.status ?? 'running',
          providerSettingsV1: reports,
          providerSettingsSourceV1: source,
        };
      });
    });
    tail = run.catch(() => {});
    return run;
  };
  const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
    if (next.scopeKey !== params.scopeKey) return;
    void refresh().catch(params.onError);
  });
  const unsubscribeMaterializations = subscribeProviderAccountSettingsMaterializations(async (materialization) => {
    if (materialization.activeServerDir !== params.activeServerDir) return;
    await refresh().catch(params.onError);
  });
  return {
    refresh,
    stop: () => {
      stopped = true;
      unsubscribe();
      unsubscribeMaterializations();
    },
  };
}
