import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { ActionOperationRows } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { ActionOperationSudoQuestion } from '@/components/inbox/actionOperations/ActionOperationSudoQuestion';
import { MachineSetupStepsChecklist } from '@/components/inbox/actionOperations/MachineSetupStepsChecklist';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import type { MachineSetupStepChecklist } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MeterBar } from '@/components/ui/lists/MeterBar';
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

function StoppedHead(props: StoppedNoticeProps & Readonly<{
  investigate: Readonly<{ pending: boolean; launch: () => void }> | null;
}>) {
  // The run card's head when it stopped (lab L7-failed): plain words, the ways forward trailing, Retry last as the
  // primary. The failed step below carries the one failure mark; the head and the run's row stay neutral.
  return (
    <Item
      testID="machine-setup-stopped"
      mode="info"
      showChevron={false}
      accessoryLayout="adaptive"
      title={t('machinePresets.setup.tab.stoppedAt', { step: props.step })}
      {...(props.cause ? { subtitle: props.cause, subtitleLines: 0 } : {})}
      showDivider
      rightElement={props.investigate || props.onRetry ? (
        <View style={styles.headActions}>
          {props.investigate ? (
            <TextLinkButton
              testID="machine-setup-stopped.investigate"
              label={t('inbox.work.healthNotice.investigate')}
              tone="strong"
              disabled={props.investigate.pending}
              onPress={props.investigate.launch}
            />
          ) : null}
          {props.onRetry ? (
            <RoundButton
              testID="machine-setup-stopped.action"
              size="small"
              display="default"
              title={t('machinePresets.setup.tab.retryFrom', { step: props.step })}
              onPress={props.onRetry}
            />
          ) : null}
        </View>
      ) : undefined}
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
  return <StoppedHead {...props} investigate={subject ? { pending: investigation.pending, launch } : null} />;
}

/**
 * Where a Setup run stopped, its cause, and the two ways forward: retry from that step (the owner's reapply
 * review re-checks every step, so finished ones come back done) or hand the operation to an agent, the same
 * investigation subject the operation detail uses. Mounted only while stopped.
 */
function MachineSetupStoppedNotice(props: StoppedNoticeProps) {
  const owner = useOptionalAccountNoticeInvestigation();
  return owner ? <StoppedNoticeWithInvestigation {...props} /> : <StoppedHead {...props} investigate={null} />;
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
    machineName: string;
    onRetry: (() => void) | null;
  }>,
) {
  const { theme } = useUnistyles();
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
  const position = readRunPosition(steps);
  const positionText = position
    ? t(stopped ? 'machinePresets.setup.tab.stoppedAtStepOf' : 'machinePresets.setup.tab.stepOf', {
        current: position.current, total: position.total, machine: props.machineName,
      })
    : null;
  // The step that asks: the one waiting on the person, else the one running when the question came.
  const asking = sudoPrompt
    ? steps.items.find((item) => item.needsAttention)
      ?? steps.items.find((item) => steps.executionById[item.id]?.status === 'running') ?? null
    : null;
  return (
    <ItemGroup
      surface="none"
      testID="machine-setup-operation"
      title={t('machinePresets.setup.tab.applying')}
    >
      <MachineSetupStepsChecklist
        testID="machine-setup-steps"
        title={null}
        operation={progressOperation}
        attachment={domainRef}
        stepOutput
        header={
          <>
            {/* What needs the person opens the run card, once: the password question, or where it stopped. */}
            {!sudoPrompt && stoppedTitle ? (
              <MachineSetupStoppedNotice
                serverId={props.serverId}
                operation={progressOperation.snapshot}
                step={stoppedTitle}
                cause={typeof stopped?.subtitle === 'string' ? stopped.subtitle : undefined}
                onRetry={runSettled ? props.onRetry : null}
              />
            ) : null}
            {sudoPrompt ? (
              <ActionOperationSudoQuestion
                key={sudoPrompt.id}
                operation={progressOperation}
                presentation="rows"
                machineName={props.machineName}
                stepTitle={asking && typeof asking.title === 'string' ? asking.title : null}
              />
            ) : null}
            {operations.length > 0 ? (
              <ActionOperationRows
                operations={operations}
                showDivider={!positionText}
                runCard={() => ({ line: positionText ?? props.machineName })}
                onOpenOperation={(operation) =>
                  openActionOperationDetail({
                    serverId: operation.serverId,
                    operationId: operation.snapshot.operationId,
                  })
                }
              />
            ) : null}
            {position && positionText ? (
              <>
                <MeterBar
                  testID="machine-setup-progress"
                  tone="neutral"
                  fillFraction={position.done / position.total}
                  height={2}
                  fillColor={theme.colors.text.primary}
                  trackColor={theme.colors.border.default}
                  progressAccessibilityLabel={positionText}
                />
              </>
            ) : null}
          </>
        }
      />
    </ItemGroup>
  );
}

/**
 * Where the run is among its reviewed steps (lab L7: "Step 2 of 3", "Stopped at step 2 of 3"): the step that waits,
 * runs or failed, and how many are done. Nothing to say once every step is done or none has started.
 */
function readRunPosition(steps: MachineSetupStepChecklist): Readonly<{ current: number; total: number; done: number }> | null {
  const total = steps.items.length;
  if (total === 0) return null;
  const index = steps.items.findIndex((item) => item.needsAttention
    || steps.executionById[item.id]?.status === 'running' || steps.executionById[item.id]?.status === 'error');
  if (index < 0) return null;
  const done = steps.items.filter((item) => steps.executionById[item.id]?.status === 'done').length;
  return { current: index + 1, total, done };
}

const styles = StyleSheet.create((theme) => ({
  // Investigate, then Retry last as the primary (lab L7-failed).
  headActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    // The primary's own hit reach overhangs its edge; keep its drawn edge off the card's.
    paddingRight: theme.space.s4,
  },
}));
