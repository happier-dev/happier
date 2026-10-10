import {
  describeActionOperationStatusLabel,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { describeManagedLifecycleState } from '@/components/settings/machines/managed/managedLifecyclePresentation';
import { t } from '@/text';

import type { ManagedMachineCreationProgress } from './managedMachineCreation';

/**
 * How one managed creation reads right now, from the creation owner's progress and its observed
 * operation only (no inferred stage journal). The Session composer badge and a Script row's
 * creation notice both read it, so a creation says the same thing wherever it is waited on.
 */
export function describeManagedCreationProgress(
  machineName: string,
  progress: ManagedMachineCreationProgress,
) {
  const setup =
    progress.kind === 'setup_pending' || progress.kind === 'failed'
      ? progress.environmentSetup
      : undefined;
  const operation =
    progress.kind === 'acquiring' || progress.kind === 'failed'
      ? progress.operation
      : progress.kind === 'setup_pending' &&
          progress.operation?.scope.machineId === progress.machineId
        ? progress.operation
        : undefined;
  const observedStatus = operation
    ? resolveActionOperationStatus(
        operation,
        (progress.kind === 'acquiring' || progress.kind === 'failed'
          ? progress.operationObservation
          : undefined) ?? 'available',
      )
    : null;
  const failed = progress.kind === 'failed' || operation?.state === 'failed';
  const label = setup
    ? progress.kind === 'failed'
      ? `${t('managedMachines.creation.setup')} · ${t('inbox.actionOperations.status.failed')}`
      : observedStatus
        ? describeActionOperationStatusLabel(observedStatus.label)
        : t('managedMachines.creation.setup')
    : observedStatus
      ? describeActionOperationStatusLabel(observedStatus.label)
      : progress.kind === 'approval'
        ? t('managedMachines.creation.approval', { name: machineName })
        : progress.kind === 'enrollment_pending'
          ? describeManagedLifecycleState({ kind: 'resourceReady' }).line
          : failed
            ? t('inbox.actionOperations.status.failed')
            : describeManagedLifecycleState({
                kind: 'creationWaiting',
                name: machineName,
              }).line;
  const tone: 'warning' | 'neutral' | 'active' = failed
    ? 'warning'
    : setup?.state === 'pending' ||
        (observedStatus && observedStatus.tone !== 'active')
      ? 'neutral'
      : 'active';
  return { setup, operation, observedStatus, failed, label, tone };
}
