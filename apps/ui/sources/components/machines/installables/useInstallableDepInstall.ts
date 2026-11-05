import * as React from 'react';
import { MachineCapabilityInstallOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { isInstallableDepUpdateAvailable } from '@/capabilities/installablesUpdateAvailable';
import type { InstallableDepDataLike } from '@/capabilities/installablesRegistry';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The one install/update runner for a machine's installable (Tools page rows and the new-session installer): it
 * runs `machines.capabilities.install`, says the outcome, then refreshes the tool's status and latest version.
 */
export function useInstallableDepInstall(
  params: Readonly<{
    machineId: string;
    serverId?: string | null;
    depId: Extract<CapabilityId, `dep.${string}`>;
    depStatus: InstallableDepDataLike | null;
    refreshStatus: () => void;
    refreshLatestVersion?: () => void;
  }>,
): Readonly<{ isInstalling: boolean; run: () => Promise<void> }> {
  const installation = useMountedActionExecution(params.serverId);
  const [isInstalling, setIsInstalling] = React.useState(false);
  const latest = React.useRef(params);
  latest.current = params;

  const run = React.useCallback(async () => {
    const {
      machineId,
      serverId,
      depId,
      depStatus,
      refreshStatus,
      refreshLatestVersion,
    } = latest.current;
    const method =
      depStatus?.installed === true &&
      isInstallableDepUpdateAvailable(depStatus)
        ? 'upgrade'
        : 'install';
    setIsInstalling(true);
    try {
      const execution = await installation.execute(
        'machines.capabilities.install',
        {
          machineId,
          serverId: serverId ?? undefined,
          capabilityId: depId,
          method,
        },
      );
      if (!execution.ok) {
        Modal.alert(t('common.error'), execution.error);
      } else {
        const invoke = MachineCapabilityInstallOutputSchema.parse(
          execution.result,
        );
        if (!invoke.supported) {
          Modal.alert(
            t('common.error'),
            invoke.reason === 'not-supported'
              ? t('deps.installNotSupported')
              : t('deps.installFailed'),
          );
        } else if (!invoke.response.ok) {
          Modal.alert(t('common.error'), invoke.response.error.message);
        } else {
          const result = invoke.response.result;
          const logPath =
            result &&
            typeof result === 'object' &&
            !Array.isArray(result) &&
            'logPath' in result &&
            typeof result.logPath === 'string'
              ? result.logPath
              : null;
          Modal.alert(
            t('common.success'),
            logPath
              ? t('deps.installLog', { path: logPath })
              : t('deps.installed'),
          );
        }
      }
      refreshStatus();
      refreshLatestVersion?.();
    } catch (e) {
      Modal.alert(
        t('common.error'),
        e instanceof Error ? e.message : t('deps.installFailed'),
      );
    } finally {
      setIsInstalling(false);
    }
  }, [installation.execute]);

  return { isInstalling, run };
}
