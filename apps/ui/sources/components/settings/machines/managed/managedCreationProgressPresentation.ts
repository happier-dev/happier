import {
  describeActionOperationStatusLabel,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { describeManagedLifecycleState } from '@/components/settings/machines/managed/managedLifecyclePresentation';
import { describeManagedInstallationFailure } from './managedCreationPresentation';
import { describeManagedAcquisitionRefusal } from './managedNativeFailurePresentation';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

import type { ManagedMachineCreationProgress } from './managedMachineCreation';
import type { SetupStepState } from '@/components/ui/setupBlocks/SetupSteps';

export type ManagedCreationProgressStep = Readonly<{
  id: 'create' | 'install' | 'copy' | 'setup' | 'ready';
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
  /** The Session gets its folder's files: "Copying project files" takes its place before Setup (lab F6). */
  options?: Readonly<{ projectFiles?: boolean }>,
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
  // A refusal before any phase ran (the controller offline, no permission) is the cause in its own words; once an
  // installation phase ran, the installer's sentence stays diagnostic detail.
  const admissionRefusal = progress.kind === 'failed' && operation?.progress?.kind !== 'phase'
    ? describeManagedAcquisitionRefusal(progress.code) : null;
  const failureMessage = (operation?.error && (progress.kind !== 'failed' || progress.code === operation.error.errorCode)
    ? describeManagedInstallationFailure(operation.error, operation.progress)
    : progress.kind === 'failed'
      ? resolveActionExecutionErrorMessage({ code: progress.code, failureCause: progress.failureCause },
        resolveSystemTaskFailureMessage({ code: progress.code }) ?? '') || null
      : null) ?? admissionRefusal;
  const steps: ManagedCreationProgressStep[] = [];
  if (progress.kind === 'session_starting') {
    const phase = operation?.progress?.kind === 'phase' ? operation.progress.phase : undefined;
    // Setup needs the files, so the copy comes first; its step is reserved before it starts, so nothing moves.
    const ids: readonly ManagedCreationProgressStep['id'][] = options?.projectFiles || phase === 'project_files_copy'
      ? ['create', 'install', 'copy', 'setup', 'ready'] : ['create', 'install', 'setup', 'ready'];
    const currentId: ManagedCreationProgressStep['id'] | null = phase === 'setup' ? 'setup'
      : phase === 'project_files_copy' ? 'copy'
      : phase === 'ssh.installCli' || phase?.startsWith('ssh.installCli.') ? 'install'
        : phase === 'machines.managed.acquire' || phase === 'native.readiness.wait'
          || phase === 'ssh.readiness.wait' || phase === 'ssh.trust' ? 'create' : null;
    const current = currentId ? ids.indexOf(currentId) : -1;
    // Only the observed phase is claimed: earlier effects may have been skipped or prepared.
    // Session success completes Ready; its receiver owns settling the required bound Setup.
    if (current >= 0 || operation?.state === 'succeeded') {
      const currentState: ManagedCreationProgressStep['state'] = operation?.state === 'succeeded' ? 'done'
        : failed ? 'failed' : observedStatus?.tone === 'active' ? 'running' : 'upcoming';
      for (const [index, id] of ids.entries()) {
        steps.push({ id, state: index === current ? currentState
          : id === 'ready' && operation?.state === 'succeeded' ? 'done' : 'upcoming' });
      }
    }
  }
  let label: string;
  if (progress.kind === 'failed') {
    const failedLabel = t('inbox.actionOperations.status.failed');
    label = setup ? `${t('managedMachines.creation.setup')} · ${failedLabel}` : failedLabel;
  } else if (observedStatus) {
    label = describeActionOperationStatusLabel(observedStatus.label);
  } else if (setup) {
    label = t('managedMachines.creation.setup');
  } else if (progress.kind === 'approval') {
    label = t('managedMachines.creation.approval', { name: machineName });
  } else {
    label = describeManagedLifecycleState(progress.kind === 'enrollment_pending'
      ? { kind: 'resourceReady' }
      : { kind: 'creationWaiting', name: machineName }).line;
  }
  const tone: 'warning' | 'neutral' | 'active' = failed
    ? 'warning'
    : setup?.state === 'pending' ||
        (observedStatus && observedStatus.tone !== 'active')
      ? 'neutral'
      : 'active';
  return { setup, operation, observedStatus, failed, failureMessage, label, tone, steps };
}
