import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { MachineVitalsNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';

import {
  formatMachineBytes,
  formatMachinePartOfWhole,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { formatAlertSustain } from '@/components/machines/vitals/machineAlertsPresentation';
import { resolveMachineResourceToneColor } from '@/components/machines/summary/machineSummaryStripModel';
import { machineVitalsNoticeHref, machineVitalsNoticeTab } from '@/components/machines/page/machinePageHref';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { InboxDismissRowMenu } from '../InboxRowMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import type { OpenUsageNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { useMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import { InboxRelativeTime } from '../InboxRelativeTime';
import { InboxWorkRow } from '../InboxWorkRow';
import { machineDiskName } from '@/components/machines/storage/storageViewModel';

/** The machine notice an open notice Artifact carries, when it is one (the same private notice union as usage). */
export function readMachineVitalsNotice(
  entry: OpenUsageNoticeArtifact,
): MachineVitalsNotificationV1 | null {
  const notice = entry.header.notice;
  return notice.topic === 'resource_limit' ? notice : null;
}

/** The notice's title and its one line of evidence, as the lab's Inbox · Machines lines say them. */
export function describeMachineVitalsNotice(
  notice: MachineVitalsNotificationV1,
  machine: string,
): Readonly<{ title: string; detail: string }> {
  const held = formatAlertSustain(Math.max(60_000, notice.at - notice.since));
  if (notice.kind === 'memory_pressure') {
    const level =
      notice.evidence.level === 'critical'
        ? t('machineVitals.memory.levels.critical')
        : t('machineVitals.memory.levels.elevated');
    if (notice.phase === 'recovered')
      return {
        title: t('machineVitals.inbox.calmAgain', { machine }),
        detail:
          notice.evidence.level === 'critical'
            ? t('machineVitals.inbox.memoryWasCritical', { duration: held })
            : t('machineVitals.inbox.memoryWasElevated', { duration: held }),
      };
    const swap =
      notice.evidence.swapUsedBytes !== undefined &&
      notice.evidence.swapTotalBytes !== undefined &&
      notice.evidence.swapTotalBytes > 0
        ? formatMachinePartOfWhole(
            notice.evidence.swapUsedBytes,
            notice.evidence.swapTotalBytes,
            'memory',
            'whole',
          )
        : null;
    return {
      title: t('machineVitals.inbox.shortOnMemory', { machine }),
      detail: swap
        ? t('machineVitals.inbox.memoryForSwap', {
            level,
            duration: held,
            used: swap.part,
            total: swap.whole,
          })
        : t('machineVitals.inbox.memoryFor', { level, duration: held }),
    };
  }
  if (notice.kind === 'cpu_busy') {
    if (notice.phase === 'recovered')
      return {
        title: t('machineVitals.inbox.calmAgain', { machine }),
        detail: t('machineVitals.inbox.cpuWas', { duration: held }),
      };
    return {
      title: t('machineVitals.inbox.cpuBusy', { machine }),
      detail: t('machineVitals.inbox.cpuAveraged', {
        percent: Math.round(notice.evidence.busyPct),
        duration: formatAlertSustain(notice.evidence.sustainMs),
      }),
    };
  }
  const volume = notice.volumeLabel ? machineDiskName({ label: notice.volumeLabel }) : notice.volumeId;
  const { freeBytes, totalBytes } = notice.evidence;
  if (notice.phase === 'recovered') {
    return {
      title: t('machineVitals.inbox.diskRoomAgain', { machine, volume }),
      detail: t('machineVitals.inbox.diskLeft', {
        free: formatMachineBytes(freeBytes, 'storage'),
        total: formatMachineBytes(totalBytes, 'storage'),
      }),
    };
  }
  const full =
    totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 100) : 100;
  return {
    title: t('machineVitals.inbox.diskFull', {
      machine,
      volume,
      percent: full,
    }),
    detail: t('machineVitals.inbox.diskLeft', {
      free: formatMachineBytes(freeBytes, 'storage'),
      total: formatMachineBytes(totalBytes, 'storage'),
    }),
  };
}

/**
 * One machine alert in the Inbox (lab `rv` AL 5, "Inbox · Machines"): the state as a sentence about the machine,
 * the evidence and its time; recovery is one quiet line with a check. Opening it lands on the machine's tab the
 * push offers; dismissing uses the same private notice owner as the usage notices beside it.
 */
export const MachineVitalsNoticeInboxRow = React.memo(
  function MachineVitalsNoticeInboxRow(
    props: Readonly<{
      entry: OpenUsageNoticeArtifact;
      notice: MachineVitalsNotificationV1;
      navigate: (route: string) => void;
      onDismiss: (entry: OpenUsageNoticeArtifact) => Promise<void>;
    }>,
  ) {
    const { theme } = useUnistyles();
    const machine = useMachine(props.notice.machineId);
    const name =
      props.notice.machineName ??
      (machine
        ? getMachineSentenceName(machine)
        : t('machineVitals.inbox.aMachine'));
    const { title, detail } = describeMachineVitalsNotice(props.notice, name);
    const recovered = props.notice.phase === 'recovered';
    const tone = recovered
      ? 'calm'
      : props.notice.kind === 'memory_pressure' &&
          props.notice.evidence.level === 'critical'
        ? 'crit'
        : 'warn';
    const iconName = recovered
      ? 'check-circle'
      : props.notice.kind === 'disk_nearly_full'
        ? 'hard-drives'
        : props.notice.kind === 'cpu_busy'
          ? 'cpu'
          : 'stack';
    const { navigate, onDismiss, entry, notice } = props;
    const open = React.useCallback(
      () => {
        beginMachinePageTabIntent({ machineId: notice.machineId }, machineVitalsNoticeTab(notice));
        navigate(machineVitalsNoticeHref(notice));
      },
      [navigate, notice],
    );
    const dismiss = React.useCallback(async () => {
      try {
        await onDismiss(entry);
      } catch {
        Modal.alert(t('common.error'), t('errors.unknownError'));
      }
    }, [entry, onDismiss]);
    return (
      <InboxWorkRow
        testID={`inbox.machine-notice.${entry.artifact.id}`}
        title={title}
        facts={[detail]}
        mark={
          <Icon
            name={iconName}
            color={
              tone === 'calm'
                ? theme.colors.text.secondary
                : resolveMachineResourceToneColor(tone, theme.colors)
            }
          />
        }
        time={<InboxRelativeTime timestamp={notice.at} />}
        onPress={open}
        trailingAccessory={
          <InboxDismissRowMenu testID={`inbox.machine-notice.dismiss.${entry.artifact.id}`} onDismiss={dismiss} />
        }
      />
    );
  },
);
