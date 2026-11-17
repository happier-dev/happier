import * as React from 'react';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { ActionOperationRows } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { ActionOperationSudoQuestion } from '@/components/inbox/actionOperations/ActionOperationSudoQuestion';
import { MachineSetupStepsChecklist } from '@/components/inbox/actionOperations/MachineSetupStepsChecklist';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import type { MachineSetupStepChecklist } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useOptionalAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import {
  readActionOperationSudoPrompt,
  type ActionOperationProjection,
} from '@/sync/domains/actionOperations/actionOperationSelectors';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { t } from '@/text';

type StoppedNoticeProps = Readonly<{
  serverId: string;
  operation: ActionOperationSnapshotV1;
  step: string;
  cause: string | undefined;
  onRetry: (() => void) | null;
}>;

function StoppedBanner(props: StoppedNoticeProps & Readonly<{
  investigate: Readonly<{ pending: boolean; launch: () => void }> | null;
}>) {
  return (
    <AttentionBanner
      testID="machine-setup-stopped"
      tone="neutral"
      iconName="x-circle"
      title={t('machinePresets.setup.tab.stoppedAt', { step: props.step })}
      description={props.cause}
      action={props.onRetry ? { label: t('machinePresets.setup.tab.retryFrom', { step: props.step }), onPress: props.onRetry } : null}
      secondaryAction={props.investigate ? {
        label: t('inbox.work.healthNotice.investigate'),
        icon: 'sparkle',
        loading: props.investigate.pending,
        onPress: props.investigate.launch,
      } : null}
    />
  );
}

/** Investigate needs the Account's investigation owner; it is mounted only under that owner's boundary. */
function StoppedNoticeWithInvestigation(props: StoppedNoticeProps) {
  const { operationId } = props.operation;
  const machineId = props.operation.scope.machineId;
  const subject = React.useMemo((): TriageFailureSubjectV1 | null => props.operation.state === 'failed' ? {
    kind: 'managedMachineOperation', operation: { serverId: props.serverId, machineId, operationId },
  } : null, [props.operation.state, props.serverId, machineId, operationId]);
  const investigation = useInvestigateFailure(subject);
  const launch = React.useCallback(() => { void investigation.launch('review'); }, [investigation]);
  return <StoppedBanner {...props} investigate={subject ? { pending: investigation.pending, launch } : null} />;
}

/**
 * Where a Setup run stopped, its cause, and the two ways forward: retry from that step (the owner's reapply
 * review re-checks every step, so finished ones come back done) or hand the operation to an agent, the same
 * investigation subject the operation detail uses. Mounted only while stopped.
 */
function MachineSetupStoppedNotice(props: StoppedNoticeProps) {
  const owner = useOptionalAccountNoticeInvestigation();
  return owner ? <StoppedNoticeWithInvestigation {...props} /> : <StoppedBanner {...props} investigate={null} />;
}

/**
 * The Setup tab's run region (lab L7): what needs the person, once, at the head (the Machine's password question
 * while the run waits, or where it stopped), then the operation's reviewed steps in place. The Setup tab and its
 * `/dev/machine-setup-run` specimen both mount this; neither re-derives a run state.
 */
export function MachineSetupRunRegion(
  props: Readonly<{
    serverId: string;
    /** The run the person started: its row heads the checklist and its settlement offers Retry. */
    operation: ActionOperationProjection | null;
    /** The operation whose machineSetup attachment carries the reviewed steps (the run itself or its child). */
    progressOperation: ActionOperationProjection;
    steps: MachineSetupStepChecklist;
    onRetry: (() => void) | null;
  }>,
) {
  const { progressOperation, steps } = props;
  const domainRef = progressOperation.snapshot.domainRef;
  const operations = React.useMemo(
    () => (props.operation ? [props.operation] : []),
    [props.operation],
  );
  if (domainRef?.kind !== 'machineSetup') return null;
  const sudoPrompt = readActionOperationSudoPrompt(progressOperation.snapshot);
  const stopped = isActionOperationTerminal(progressOperation.snapshot.state)
    ? (steps.items.find(
        (item) => steps.executionById[item.id]?.status === 'error',
      ) ?? null)
    : null;
  const stoppedTitle =
    stopped && typeof stopped.title === 'string' ? stopped.title : null;
  const runSettled = props.operation
    ? isActionOperationTerminal(props.operation.snapshot.state)
    : true;
  return (
    <ItemGroup
      surface="none"
      testID="machine-setup-operation"
      title={t('machinePresets.setup.tab.applying')}
    >
      {sudoPrompt ? (
        <ActionOperationSudoQuestion
          key={sudoPrompt.id}
          operation={progressOperation}
        />
      ) : stoppedTitle ? (
        <MachineSetupStoppedNotice
          serverId={props.serverId}
          operation={progressOperation.snapshot}
          step={stoppedTitle}
          cause={
            typeof stopped?.subtitle === 'string' ? stopped.subtitle : undefined
          }
          onRetry={runSettled ? props.onRetry : null}
        />
      ) : null}
      <MachineSetupStepsChecklist
        testID="machine-setup-steps"
        title={null}
        operation={progressOperation}
        attachment={domainRef}
        stepOutput
        header={
          operations.length > 0 ? (
            <ActionOperationRows
              operations={operations}
              showDivider
              onOpenOperation={(operation) =>
                openActionOperationDetail({
                  serverId: operation.serverId,
                  operationId: operation.snapshot.operationId,
                })
              }
            />
          ) : undefined
        }
      />
    </ItemGroup>
  );
}
