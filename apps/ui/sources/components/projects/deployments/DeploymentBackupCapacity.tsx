import * as React from 'react';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { fetchMachineStoragePathCapacityViaAction } from '@/sync/domains/machines/storage/machineRpc';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** Observe the selected destination filesystem through the existing capacity Action. */
export function useBackupPathCapacity(serverId: string, machineId: string | undefined, path: unknown,
  lifetime: ServerAccountScopeLifetime | undefined, enabled: boolean) {
  const machineIds = React.useMemo(() => [machineId], [machineId]);
  const names = useMachineDisplayNamesById(machineIds, { serverId });
  const machineName = machineId ? names[machineId] ?? machineId : '';
  const selectedPath = typeof path === 'string' ? path : '';
  const accountId = lifetime?.scope.accountId;
  const [observation, setObservation] = React.useState<Readonly<{
    serverId: string; machineId: string; path: string; accountId: string; capacity: StoragePathCapacityV1;
  }> | null>(null);
  React.useEffect(() => {
    if (!enabled || !selectedPath || !machineId || !accountId || !lifetime?.isCurrent()) return;
    const controller = new AbortController();
    void fetchMachineStoragePathCapacityViaAction({ serverId, machineId, path: selectedPath,
      expectedAccountId: accountId, signal: controller.signal }).then(result => {
      if (controller.signal.aborted || !lifetime.isCurrent()) return;
      setObservation({ serverId, machineId, path: selectedPath, accountId,
        capacity: result.ok ? result.value : { status: 'unknown', path: selectedPath, reason: result.errorCode ?? result.reason } });
    });
    return () => controller.abort();
  }, [enabled, selectedPath, machineId, serverId, accountId, lifetime]);
  const capacity = enabled && observation?.serverId === serverId && observation.machineId === machineId
    && observation.path === selectedPath && observation.accountId === accountId ? observation.capacity : undefined;
  return { capacity, machineName };
}

export function BackupPathCapacityReview(props: Readonly<{ capacity?: StoragePathCapacityV1; machine: string; testID: string }>) {
  const { capacity } = props;
  if (!capacity) return <Item testID={`${props.testID}.capacityReview`} mode="info"
    title={t('projects.deployments.settingsSections.setupCapacityUnknown')}
    subtitle={t('projects.deployments.settingsSections.setupCapacityAtBackupMachine')} />;
  // A read that couldn't say goes through the page's failure line: the sentence names where, the code stays behind Details.
  if (capacity.status !== 'known') return <SurfaceStateCard testID={`${props.testID}.capacity`} size="line" kind="unavailable"
    title={t('projects.deployments.settingsSections.setupCapacityUnknown')}
    // The directory is the field right above; the line names only the Machine whose disk it is.
    reason={props.machine} diagnosticCode={capacity.reason} />;
  return <Item testID={`${props.testID}.capacity`} mode="info"
    title={t('projects.deployments.settingsSections.setupCapacityKnown')}
    detail={formatMachineBytes(capacity.freeBytes, 'storage')}
    // Which disk: the Machine, then the volume's own name or a mount other than the root one ("/" says nothing, R15-D9).
    subtitle={[...new Set([props.machine, capacity.volume?.label, capacity.volume?.mountPath, formatAsOfTime(capacity.observedAt)]
      .filter(name => name && name !== '/'))].join(' · ')} />;
}
