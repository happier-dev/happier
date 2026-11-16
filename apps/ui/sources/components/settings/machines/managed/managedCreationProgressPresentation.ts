import {
  describeActionOperationStatusLabel,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { describeManagedLifecycleState } from '@/components/settings/machines/managed/managedLifecyclePresentation';
import { t } from '@/text';

import type { ManagedMachineCreationProgress } from './managedMachineCreation';
import type { SetupStepState } from '@/components/ui/setupBlocks/SetupSteps';

export type ManagedCreationProgressStep = Readonly<{
  id: 'create' | 'install' | 'setup' | 'ready';
  state: Extract<SetupStepState, 'done' | 'running' | 'upcoming' | 'failed'>;
}>;

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
      ? progress.machineSetup
      : undefined;
  const operation =
    progress.kind === 'acquiring' || progress.kind === 'failed' || progress.kind === 'session_starting'
      ? progress.operation
      : progress.kind === 'setup_pending' &&
          progress.operation?.scope.machineId === progress.machineId
        ? progress.operation
        : undefined;
  const observedStatus = operation
    ? resolveActionOperationStatus(
        operation,
        (progress.kind === 'acquiring' || progress.kind === 'failed' || progress.kind === 'session_starting'
          ? progress.operationObservation
          : undefined) ?? 'available',
      )
    : null;
  const failed = progress.kind === 'failed' || operation?.state === 'failed' || operation?.state === 'cancelled';
  const steps: ManagedCreationProgressStep[] = [];
  if (progress.kind === 'session_starting') {
    const phase = operation?.progress?.kind === 'phase' ? operation.progress.phase : undefined;
    const current = phase === 'setup' ? 2
      : phase === 'ssh.installCli' || phase?.startsWith('ssh.installCli.') ? 1
        : phase === 'machines.managed.acquire' || phase === 'native.readiness.wait'
          || phase === 'ssh.readiness.wait' || phase === 'ssh.trust' ? 0 : -1;
    // Only the observed phase is claimed: earlier effects may have been skipped or prepared.
    // Session success completes Ready; its receiver owns settling the required bound Setup.
    if (current >= 0 || operation?.state === 'succeeded') {
      const currentState: ManagedCreationProgressStep['state'] = operation?.state === 'succeeded' ? 'done'
        : failed ? 'failed' : observedStatus?.tone === 'active' ? 'running' : 'upcoming';
      for (const [index, id] of (['create', 'install', 'setup', 'ready'] as const).entries()) {
        steps.push({ id, state: index === current ? currentState
          : id === 'ready' && operation?.state === 'succeeded' ? 'done' : 'upcoming' });
      }
    }
  }
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
  return { setup, operation, observedStatus, failed, label, tone, steps };
}
