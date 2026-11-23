import * as React from 'react';

import { MachineOfflineNotice } from '@/components/machines/page/MachineOfflineNotice';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { MachineProcessesState } from '@/sync/domains/machines/processes/machineProcessesStore';
import { t } from '@/text';

/** The same unavailable/read-failure presentation for the tree and its pushed owner/process page. */
export function ProcessesStateCard(props: Readonly<{
  status: MachineProcessesState['status'];
  reason: string | undefined;
  online: boolean | null;
  machineName: string;
  onRetry: () => void;
  onOpenDoctor?: () => void;
}>) {
  if (props.online === null) return <SurfaceStateCard testID="machine-processes-unknown" kind="unavailable" title={t('common.unknown')} />;
  if (props.online === false) {
    // The page header already says Offline (or Asleep); the tab says what that means here, in the page's one notice.
    return <MachineOfflineNotice testID="machine-processes-offline-empty" title={t('machineProcesses.states.offlineReason')} />;
  }
  if (props.status === 'loading') {
    return <SurfaceStateCard testID="machine-processes-loading" kind="loading" title={t('machineProcesses.states.loading')} />;
  }
  if (props.status === 'not_supported') {
    return <SurfaceStateCard testID="machine-processes-older" kind="unavailable"
      title={t('machineProcesses.states.olderHappier', { machine: props.machineName })} />;
  }
  return <SurfaceStateCard testID="machine-processes-error" kind="error"
    title={t('machineProcesses.states.errorTitle', { machine: props.machineName })}
    reason={props.reason === 'helper_missing' ? t('machineProcesses.states.helperMissing') : t('machineProcesses.states.errorBody')}
    diagnosticCode={props.reason ?? null}
    action={{ label: t('machineProcesses.states.tryAgain'), onPress: props.onRetry, testID: 'machine-processes-retry' }}
    secondaryAction={props.onOpenDoctor ? { label: t('machineProcesses.states.openDoctor'), onPress: props.onOpenDoctor } : undefined} />;
}
