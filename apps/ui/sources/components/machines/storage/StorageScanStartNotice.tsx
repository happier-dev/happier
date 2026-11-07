import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { MachineStorageScanStartFailure } from '@/sync/domains/machines/storage/machineStorageStore';
import { t } from '@/text';
import { describeStorageFailure } from './storageViewModel';

/**
 * A scan that did not start says why in one calm line, with the way forward: Try again, or for a machine that
 * has whole-disk scanning off, the control that turns it on. The store keeps the reason until the next attempt.
 * One line for the page's own group: the invitation's panel, or the section above a stopped scan.
 */
export function StorageScanStartNotice(props: Readonly<{
  failure: MachineStorageScanStartFailure;
  machineName: string;
  onRetry: () => void;
  onTurnOn: () => void;
}>) {
  const { reason } = props.failure;
  const action = reason === 'whole_disk_disabled'
    ? { label: t('machineStorage.disk.startFailed.turnOn'), onPress: props.onTurnOn, testID: 'machine-storage-disk-start-turn-on' }
    // An approval request already went out, and an older Happier will not change by asking again.
    : reason === 'approval_requested' || reason === 'older_happier'
      ? undefined
      : { label: t('machineStorage.tryAgain'), onPress: props.onRetry, testID: 'machine-storage-disk-start-retry' };
  return (
    <SurfaceStateCard
      testID="machine-storage-disk-start-failed"
      kind="error"
      size="line"
      title={t('machineStorage.disk.startFailed.title')}
      reason={reason === 'whole_disk_disabled'
        ? t('machineStorage.disk.startFailed.disabled')
        : reason === 'older_happier'
          ? t('machineStorage.disk.startFailed.olderHappier', { machine: props.machineName })
          : reason === 'approval_requested'
            ? t('machineStorage.disk.startFailed.approval')
            : t('machineStorage.disk.startFailed.generic')}
      {...describeStorageFailure(props.failure)}
      {...(action ? { action } : {})}
    />
  );
}
