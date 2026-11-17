import * as React from 'react';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { MachineSetupRunProgress } from '@/components/machines/setup/MachineSetupRunRegion';
import {
  useMachineSetup,
  type MachineSetupState,
} from '@/components/machines/setup/useMachineSetup';
import { MachineSetupPlanReview } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import type { ManagedProvisionerCard } from '@/components/settings/machines/managed/managedMachineDisplay';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { LeadSentence } from '@/components/ui/text/LeadSentence';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

export type MachineIsolationKindSetup = Readonly<{
  setup: MachineSetupState;
  /** The kind's prerequisite installs through Machine Setup here (its readiness carries the setup sources). */
  sourceBacked: boolean;
  /** Plans the kind's setup sources for review (Continue into Set up, Try again). */
  review: () => void;
  /** The run this sheet started is going, or settled without success; its region is the step's content. */
  running: boolean;
}>;

/**
 * A sandbox kind's Set up step on Machine Setup's own lifecycle (MACH-KIND-SETUP-1117 contract): the readiness owner
 * gives the kind's setup sources, Machine Setup plans them for review, Apply runs them through its approval, and its run
 * reports progress and a typed failure. The sheet adds no installer and no state of its own.
 */
export function useMachineIsolationKindSetup(
  input: Readonly<{
    serverId: string;
    /** The Machine the sandboxes run on: the readiness check's controller. */
    hostMachineId: string | null;
    card: ManagedProvisionerCard | null;
    active: boolean;
  }>,
): MachineIsolationKindSetup {
  const hostMachineId = input.hostMachineId ?? '';
  const canManage = useServerScopedMachine(
    input.serverId,
    hostMachineId,
    canManageMachine,
  );
  const sources =
    input.card?.setupSources && input.card.setupSources.length > 0
      ? input.card.setupSources
      : null;
  const sourceBacked = sources !== null && hostMachineId !== '' && canManage;
  const setup = useMachineSetup({
    serverId: input.serverId,
    machineId: hostMachineId,
    active: input.active && sourceBacked,
    online: null,
    canCheck: canManage,
  });
  const { prepare } = setup;
  const review = React.useCallback(() => {
    if (sources && sourceBacked) void prepare({ kind: 'sources', sources });
  }, [prepare, sourceBacked, sources]);
  return { setup, sourceBacked, review, running: setup.operationId !== null };
}

/** Whether the run this sheet started has finished well, so the kind's readiness is read again. */
export function isMachineIsolationKindSetupDone(
  setup: MachineSetupState,
): boolean {
  return (
    setup.operation !== null &&
    isActionOperationTerminal(setup.operation.snapshot.state) &&
    setup.operation.snapshot.state === 'succeeded'
  );
}

/**
 * The Set up step's content for a kind that installs through Machine Setup (lab `setup-install`, `setup-ask`,
 * `setup-running`): one lead sentence, then the plan to review, the administrator ask while the approval waits, the run's
 * steps in place, or the plan's failure with its typed cause.
 */
export function MachineIsolationKindSetupBody(
  props: Readonly<{
    serverId: string;
    machineName: string;
    kind: MachineIsolationKindSetup;
  }>,
) {
  const { setup } = props.kind;
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const nameOf = React.useCallback(
    () => props.machineName,
    [props.machineName],
  );
  if (props.kind.running) {
    return (
      <>
        <LeadSentence
          statement={t('machineDetailPage.isolation.add.installingStatement', {
            machine: props.machineName,
          })}
          detail={t('machineDetailPage.isolation.add.installingDetail')}
        />
        <MachineSetupRunProgress
          serverId={props.serverId}
          setup={setup}
          machineName={props.machineName}
          localize={localize}
          onRetry={
            setup.operation
              ? () => {
                  setup.dismissOperation();
                  props.kind.review();
                }
              : null
          }
        />
      </>
    );
  }
  const failure = setup.failure
    ? presentActionFailureOutcome(
        setup.failure.failure ?? {
          ok: false,
          errorCode: setup.failure.code,
          error: setup.failure.code,
        },
      )
    : null;
  return (
    <>
      <LeadSentence
        statement={t('machineDetailPage.isolation.add.installStatement', {
          machine: props.machineName,
        })}
        detail={t('machineDetailPage.isolation.add.installDetail')}
      />
      {failure ? (
        <SurfaceStateCard
          testID="machine-isolation-add.setup-error"
          kind="error"
          size="line"
          title={t(
            setup.failure?.during === 'apply'
              ? 'machinePresets.setup.applyFailed'
              : 'machinePresets.setup.review.planFailed',
            { machine: props.machineName },
          )}
          reason={failure.reason ?? undefined}
          diagnosticCode={failure.code ?? setup.failure?.code}
          diagnosticDetail={failure.technicalDetails
            .map((line) => `${line.label}: ${line.value}`)
            .join('\n')}
        />
      ) : setup.review?.prepared ? (
        <MachineSetupPlanReview
          testID="machine-isolation-add.setup-plan"
          prepared={setup.review.prepared}
          nameOf={nameOf}
          disabled={setup.pending !== null}
        />
      ) : (
        <PageLoadingRows testID="machine-isolation-add.setup-plan-loading" />
      )}
      {setup.approvalId ? (
        // The administrator ask waits as the Machine's approval; the run continues once it is allowed.
        <AttentionBanner
          testID="machine-isolation-add.setup-approval"
          tone="neutral"
          title={t('approvals.title')}
          description={t('approvals.status.open')}
        />
      ) : null}
    </>
  );
}
