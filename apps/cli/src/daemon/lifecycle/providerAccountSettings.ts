import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { listExistingConnectedServiceHomeSelections } from '@/daemon/connectedServices/homes/inventory';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue, Disposable } from '@happier-dev/plugin-sdk';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { getActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { listConnectedServiceMaterializedIdentityRoots } from '@/daemon/connectedServices/materialize/cleanup/ConnectedServiceMaterializedHomeCleanupScheduler';
import { resolveConnectedServiceNativeHomeRoot } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { subscribeProviderAccountSettingsMaterializations } from './providerAccountSettingsMaterializations';
import packageJson from '../../../package.json';

export function createProviderAccountSettingsController(params: Readonly<{
  scopeKey: string;
  processEnv: NodeJS.ProcessEnv;
  materializationBaseDir: string;
  activeServerDir: string;
  apiMachine: Pick<ApiMachineClient, 'updateDaemonState'>;
  onError: (error: unknown) => void;
}>) {
  let stopped = false;
  let tail = Promise.resolve();
  let boundLease: PluginRuntimeRegistryLease | null = null;
  let watches: Disposable[] = [];
  let settingIds: string[] = [];
  const isCurrentAccount = () => !stopped && getActiveAccountSettingsSnapshot()?.scopeKey === params.scopeKey;
  const disposeWatches = async () => {
    const previous = watches; watches = [];
    await Promise.all(previous.map(watch => watch.dispose()));
  };
  const refresh = (): Promise<void> => {
    const run = tail.then(async () => {
      if (!isCurrentAccount()) return;
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      let releaseLease = true;
      try {
        const declarations = lease.registry.contributes.agents.filter(agent => agent.richDefinition?.definition.accountSettings);
        if (boundLease?.registry !== lease.registry) {
          await disposeWatches();
          await boundLease?.release();
          boundLease = lease; releaseLease = false;
          settingIds = [...new Set(declarations.flatMap(agent => agent.richDefinition!.definition.accountSettings!.settingLocalIds))];
          for (const agent of declarations) {
            const ids = agent.richDefinition!.definition.accountSettings!.settingLocalIds;
            if (!agent.pluginId) continue;
            const service = lease.registry.createPluginSettingsService?.({ pluginId: agent.pluginId, scope: { kind: 'account' } });
            if (service) watches.push(service.watch(change => {
              if (change.changedIds.some(id => ids.includes(id))) void refresh().catch(params.onError);
            }));
          }
        }
        const reports: Record<string, JsonValue> = {};
        for (const declaration of declarations) {
          if (!isCurrentAccount()) return;
          try {
            const entry = await lease.registry.acquireAgentCatalogEntry?.(declaration.id);
            if (!entry?.applyAccountSettings) throw new Error('Declared Agent Account settings hook is unavailable');
            const descriptor = await entry.getConnectedServiceStateSharingDescriptor?.();
            const nativeHome = descriptor?.nativeHome;
            if (!nativeHome) throw new Error('Agent Account settings home descriptor is unavailable');
            const targets = [{ id: 'native', directory: resolveConnectedServiceNativeHomeRoot({ nativeHome,
              sourceEnvironment: params.processEnv,
              homeDir: resolveHomeDirFromEnvironment(params.processEnv),
            }) }];
            for (const root of await listConnectedServiceMaterializedIdentityRoots(params.materializationBaseDir)) {
              const directory = join(root.path, declaration.id);
              const observed = await lstat(directory).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
              });
              if (observed?.isDirectory()) targets.push({ id: root.name, directory });
            }
            for (const selection of await listExistingConnectedServiceHomeSelections(params.activeServerDir)) {
              const directory = join(selection.directory, declaration.id, nativeHome.materializedDirectoryName);
              const observed = await lstat(directory).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
              });
              if (observed?.isDirectory()) targets.push({
                id: `${selection.serviceDirectoryName}:${selection.kind}:${selection.selectionId}`, directory,
              });
            }
            if (!isCurrentAccount()) return;
            reports[declaration.id] = await entry.applyAccountSettings(targets);
          } catch (error) {
            params.onError(error);
            reports[declaration.id] = { status: 'error', reason: 'provider_settings_failed' };
          }
        }
        if (!isCurrentAccount()) return;
        await params.apiMachine.updateDaemonState(state => {
          const source = typeof state?.startedAt === 'number' && Number.isFinite(state.startedAt)
            ? { pid: process.pid, cliVersion: packageJson.version, startedAt: state.startedAt } : undefined;
          if (state && isDeepStrictEqual(state.providerSettingsV1, reports)
            && isDeepStrictEqual(state.providerSettingsSourceV1, source)) return state;
          return { ...state, status: state?.status ?? 'running', providerSettingsV1: reports, providerSettingsSourceV1: source };
        });
      } finally {
        if (releaseLease) await lease.release();
      }
    });
    tail = run.catch(() => {});
    return run;
  };
  const unsubscribers = [
    subscribeActiveAccountSettingsKeys(() => ({ settings: settingIds, rawSettings: settingIds }), () => {
      void refresh().catch(params.onError);
    }),
    pluginReloadController.subscribe(() => { void refresh().catch(params.onError); }),
    subscribeProviderAccountSettingsMaterializations(async materialization => {
      if (materialization.activeServerDir === params.activeServerDir) await refresh().catch(params.onError);
    }),
  ];
  return {
    refresh,
    stop: async () => {
      stopped = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      await tail;
      await disposeWatches();
      await boundLease?.release(); boundLease = null;
    },
  };
}
