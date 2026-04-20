import { installDaemonService, uninstallDaemonService } from '@/daemon/service/installer';

import type {
  BackgroundServiceRepairAction,
  BackgroundServiceRepairApplyRuntime,
  BackgroundServiceRepairPlan,
} from './types';

type BackgroundServiceRepairRemovedService = Extract<BackgroundServiceRepairAction, Readonly<{ kind: 'remove-service' }>>['service'];
type BackgroundServiceRepairInstallDefaultFollowingService = Extract<
  BackgroundServiceRepairAction,
  Readonly<{ kind: 'install-default-following-service' }>
>;

function hasPreexistingExactDefaultTarget(
  plan: BackgroundServiceRepairPlan,
  action: BackgroundServiceRepairInstallDefaultFollowingService,
): boolean {
  return plan.existingServices.some((service) =>
    service.serverId === 'default'
    && service.targetMode === 'default-following'
    && service.releaseChannel === action.releaseChannel
    && service.mode === action.mode);
}

export async function applyBackgroundServiceRepairPlan(
  plan: BackgroundServiceRepairPlan,
  runtime: BackgroundServiceRepairApplyRuntime,
): Promise<Readonly<{ executedActions: readonly string[] }>> {
  const executedActions: string[] = [];
  const removedServices: BackgroundServiceRepairRemovedService[] = [];
  const installedDefaultFollowingServices: BackgroundServiceRepairInstallDefaultFollowingService[] = [];

  try {
    for (const action of plan.actions) {
      if (action.kind === 'remove-service') {
        await uninstallDaemonService({
          platform: runtime.platform,
          uid: runtime.uid ?? undefined,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
          mode: action.service.mode,
          channel: action.service.releaseChannel,
          targetMode: action.service.targetMode,
          instanceId: action.service.instanceId,
          installedPath: action.service.installedPath,
          runCommands: true,
        });
        removedServices.push(action.service);
        executedActions.push(`remove:${action.service.label}`);
        continue;
      }

      const hadPreexistingExactDefaultTarget = hasPreexistingExactDefaultTarget(plan, action);
      if (!hadPreexistingExactDefaultTarget) {
        installedDefaultFollowingServices.push(action);
      }
      await installDaemonService({
        platform: runtime.platform,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        nodePath: runtime.nodePath,
        entryPath: runtime.entryPath,
        mode: action.mode,
        systemUser: runtime.systemUser || undefined,
        channel: action.releaseChannel,
        targetMode: 'default-following',
        strategy: 'replace-ring',
        runCommands: true,
      });
      if (hadPreexistingExactDefaultTarget) {
        installedDefaultFollowingServices.push(action);
      }
      executedActions.push(`install-default:${action.releaseChannel}`);
    }

    return { executedActions };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const action of [...installedDefaultFollowingServices].reverse()) {
      try {
        await uninstallDaemonService({
          platform: runtime.platform,
          uid: runtime.uid ?? undefined,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
          mode: action.mode,
          channel: action.releaseChannel,
          targetMode: 'default-following',
          runCommands: true,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const service of [...removedServices].reverse()) {
      try {
        await installDaemonService({
          platform: runtime.platform,
          uid: runtime.uid ?? undefined,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
          nodePath: runtime.nodePath,
          entryPath: runtime.entryPath,
          mode: service.mode,
          systemUser: runtime.systemUser || undefined,
          channel: service.releaseChannel,
          targetMode: service.targetMode,
          instanceId: service.instanceId,
          strategy: 'add',
          runCommands: true,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Background service repair failed and rollback could not restore every removed service');
    }

    throw error;
  }
}
