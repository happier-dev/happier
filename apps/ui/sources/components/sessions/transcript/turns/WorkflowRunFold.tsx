import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import {
  HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX,
  HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX,
  HappierWorkUpdateCard,
  joinHappierFacts,
  type HappierWorkUpdateCardFact,
} from '@happier-dev/plugin-ui/presentation';

import { describeWorkKind } from '@/components/sessions/work/workerKindGlyphs';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { renderWorkUpdateCardSurface, useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { WorkflowFlowView } from '@/components/workflows/flow/WorkflowFlowView';
import { WorkflowBuiltinMark } from '@/components/workflows/presentation/WorkflowBuiltinMark';
import { useWorkflowInlineRunControls } from '@/components/workflows/run/useWorkflowInlineRunControls';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { WorkflowRunFoldHeader } from '@/components/workflows/presentation/WorkflowRunFoldHeader';
import {
  describeReviewAndConvergeRound,
  describeWorkflowTriggerRunFold,
  REVIEW_AND_CONVERGE_CATALOG_REF,
  type WorkflowTriggerRunFoldPresentation,
} from '@/components/workflows/presentation/workflowTriggerRunFoldPresentation';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { useSessionManagedWorkflowRunFlow } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import {
  useActiveServerAccountScope,
  useActiveServerAccountScopeLifetime,
  useWorkflowRun,
} from '@/sync/store/hooks';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';

import { useTranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import type { WorkflowOriginRunFold } from '../turnGrouping/workflowTranscriptTurns';

type RunRow = ReturnType<typeof useWorkflowRun>;

/**
 * The exact Run behind a fold, read through the one Account-scoped Run row owner.
 *
 * The accepted source, inputs and recorded result are frozen once the Run settles, so a mounted fold
 * opens the Run once and once more when its change-stream summary turns terminal; the store keeps the
 * body for every other surface. Static, public or another Home's transcripts read nothing private.
 */
function useTriggerRunRow(
  runId: string,
  serverId: string | null | undefined,
): RunRow {
  const source = useSessionTranscriptSource();
  const activeScope = useActiveServerAccountScope();
  const workflowsAvailable = useWorkflowsAvailability().available;
  const readable =
    source.kind === 'app' &&
    workflowsAvailable &&
    activeScope !== null &&
    typeof serverId === 'string' &&
    areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId);
  const row = useWorkflowRun(readable ? runId : null);
  const summaryTerminal = row?.summary
    ? isTerminalWorkflowRunState(row.summary.state)
    : false;
  const detailCurrent =
    row?.detail !== undefined &&
    (!summaryTerminal || isTerminalWorkflowRunState(row.detail.run.state));
  React.useEffect(() => {
    if (!readable || detailCurrent) return;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    void workflowRunDetailActions.getRun(runId, controller.signal).then(
      (detail) => {
        if (controller.signal.aborted || !lifetime.isCurrent()) return;
        publishOpenedWorkflowRunDetail(detail, lifetime.scope);
      },
      () => undefined,
    );
    return () => {
      retirement.dispose();
      controller.abort();
    };
  }, [detailCurrent, readable, runId, summaryTerminal]);
  return readable ? row : null;
}

/** Keep going's second opinion settles a Notify me node only when it disagreed (08 §3.1). */
const SecondOpinionOutcome = React.memo(function SecondOpinionOutcome(
  props: Readonly<{
    runId: string;
    serverId: string | null;
    children: (disagreed: boolean) => React.ReactNode;
  }>,
) {
  const flow = useSessionManagedWorkflowRunFlow(props.runId, props.serverId);
  const disagreed =
    flow?.runStates
      .get('notify')
      ?.some((state) => state.lifecycle === 'completed') === true;
  return <>{props.children(disagreed)}</>;
});

export const WorkflowRunFold = React.memo(function WorkflowRunFold(
  props: Readonly<{
    turnId: string;
    run: WorkflowOriginRunFold;
    serverId?: string | null;
    children: React.ReactNode;
    reducedMotion?: boolean;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  const notifyLayoutMutation = useTranscriptRowLayoutMutation();
  const maxWidthStyle = useLayoutMaxWidthStyle();
  const row = useTriggerRunRow(props.run.runId, props.serverId);
  const changeExpanded = React.useCallback(
    (next: boolean) => {
      notifyLayoutMutation({
        reason: next ? 'expand' : 'collapse',
        sourceId: props.turnId,
      });
      setExpanded(next);
    },
    [notifyLayoutMutation, props.turnId],
  );

  const source = useSessionTranscriptSource();
  const runId = props.run.runId;
  const open = React.useMemo(() => source.navigate === null ? null : () => {
    navigateWithBlurOnWeb(() => source.navigate?.(createWorkflowRunRoute(runId, props.serverId ?? source.serverId)));
  }, [props.serverId, runId, source.navigate, source.serverId]);
  const detail = row?.detail;
  const acceptedSource = detail?.acceptedContext.source;
  const catalogRef =
    acceptedSource?.kind === 'catalog' ? acceptedSource.ref : null;
  const inputs = detail?.acceptedContext.inputs as
    | Readonly<Record<string, unknown>>
    | undefined;
  const summary = row?.summary ?? null;
  const probeSecondOpinion =
    catalogRef === 'builtin:keep-going' &&
    inputs?.secondOpinion === true &&
    summary?.state === 'succeeded';
  const renderHeader = (secondOpinionDisagreed: boolean) => {
    const presentation = describeWorkflowTriggerRunFold({
      catalogRef,
      workflowTitle:
        row?.metadata?.kind === 'available' ? row.metadata.value.title : null,
      turnCount: props.run.turnCount,
      run: summary
        ? {
            state: summary.state,
            workflowCustodyState: summary.workflowCustodyState,
          }
        : null,
      result:
        detail && isTerminalWorkflowRunState(detail.run.state)
          ? detail.result
          : undefined,
      inputs: inputs ?? null,
      secondOpinionDisagreed,
      trigger:
        summary?.origin.kind === 'automation' ? summary.origin.cause : null,
    });
    // A Review & converge that is still running is its round card (cards-T3); once it settles it folds.
    if (catalogRef === REVIEW_AND_CONVERGE_CATALOG_REF && summary !== null && !isTerminalWorkflowRunState(summary.state)) {
      return (
        <View style={styles.container}>
          <ReviewRoundCard
            runId={props.run.runId}
            serverId={props.serverId ?? null}
            summary={summary}
            inputs={inputs ?? null}
            presentation={presentation}
            canEdit={detail?.callerAccess.canEdit === true}
            onOpen={open}
          />
          {props.run.turnCount > 0 ? <View style={styles.body}>{props.children}</View> : null}
        </View>
      );
    }
    // A run that wrote no turn here has nothing to expand: the row only names its outcome and opens the run.
    if (props.run.turnCount === 0) {
      return (
        <View style={styles.container}>
          <WorkflowRunFoldHeader
            runId={props.run.runId}
            disclosure={null}
            presentation={presentation}
            onOpen={open}
          />
        </View>
      );
    }
    return (
      <View style={styles.container}>
        <ExpandableItem
          expanded={expanded}
          onExpandedChange={changeExpanded}
          showDivider={false}
          reducedMotion={props.reducedMotion}
          testID={`workflow-run-fold:${props.run.runId}`}
          header={({ expanded: isExpanded, headerProps }) => (
            <WorkflowRunFoldHeader
              runId={props.run.runId}
              disclosure={{ expanded: isExpanded, headerProps }}
              presentation={presentation}
              onOpen={open}
            />
          )}
        >
          <View style={styles.body}>{props.children}</View>
        </ExpandableItem>
      </View>
    );
  };
  return (
    <View style={[styles.outer, maxWidthStyle]}>
      {probeSecondOpinion ? (
        <SecondOpinionOutcome
          runId={props.run.runId}
          serverId={props.serverId ?? null}
        >
          {renderHeader}
        </SecondOpinionOutcome>
      ) : (
        renderHeader(false)
      )}
    </View>
  );
});

/**
 * A running Review & converge in the session it reviews (07 S15, lab cards-T3): the Work update card
 * with the round it is on, its live map, what started it, and Stop reviewing / Open run. The map
 * reads the run once while the card is mounted, through the same owner the Work rows use.
 */
const ReviewRoundCard = React.memo(function ReviewRoundCard(props: Readonly<{
  runId: string;
  serverId: string | null;
  summary: WorkflowRunSummaryV1;
  inputs: Readonly<Record<string, unknown>> | null;
  presentation: WorkflowTriggerRunFoldPresentation;
  canEdit: boolean;
  onOpen: (() => void) | null;
}>) {
  const { theme } = useUnistyles();
  const workTheme = useWorkTheme();
  const accountLifetime = useActiveServerAccountScopeLifetime();
  const flow = useSessionManagedWorkflowRunFlow(props.runId, props.serverId);
  // Every round records its first step (skipped on round one) and its panel.
  const roundsStarted = Math.max(flow?.runStates.get('verify')?.length ?? 0, flow?.runStates.get('panel')?.length ?? 0);
  const round = describeReviewAndConvergeRound(props.inputs, roundsStarted);
  const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(props.summary) });
  const facts: HappierWorkUpdateCardFact[] = props.presentation.trigger === null ? [] : [{
    id: 'trigger',
    icon: <Icon name="repeat" size={HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX} color={theme.colors.text.tertiary} />,
    label: props.presentation.trigger,
  }];
  const testID = `workflow-review-round:${props.runId}`;
  return (
    <HappierWorkUpdateCard
      testID={testID}
      tone={status.tone}
      theme={workTheme}
      host={WORK_HOST}
      renderSurface={renderWorkUpdateCardSurface}
      mark={props.presentation.icon
        ? <WorkflowBuiltinMark icon={props.presentation.icon} size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX} color={theme.colors.text.secondary} />
        : <Icon name="tree-structure" size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX} color={theme.colors.text.secondary} />}
      title={props.presentation.workflowName ?? t('workflows.run.untitled')}
      state={round ?? status.word}
      meta={joinHappierFacts(describeWorkKind('workflow_run'), formatShortRelativeTime(Date.parse(props.summary.createdAt)))}
      facts={facts}
      actions={(
        <>
          {accountLifetime !== null && props.canEdit && props.summary.availability.cancel ? (
            <StopReviewingAction run={props.summary} accountLifetime={accountLifetime} testID={`${testID}-stop`} />
          ) : null}
          {props.onOpen ? (
            <RoundButton testID={`${testID}-open`} size="small" display="secondary" title={t('workflows.run.open')} onPress={props.onOpen} />
          ) : null}
        </>
      )}
    >
      {flow === null ? null : (
        <WorkflowFlowView
          projection={flow.projection}
          runStates={flow.runStates}
          selectedNodeId={null}
          onSelectNode={props.onOpen ?? undefined}
          density="compact"
          testIDPrefix={`${testID}-map`}
        />
      )}
    </HappierWorkUpdateCard>
  );
});

/** Stop reviewing is the Run's own Stop, through the inline Run controls owner; the run then folds. */
function StopReviewingAction(props: Readonly<{
  run: WorkflowRunSummaryV1;
  accountLifetime: ServerAccountScopeLifetime;
  testID: string;
}>) {
  const controls = useWorkflowInlineRunControls({
    run: props.run,
    definition: null,
    acceptedContext: null,
    accountLifetime: props.accountLifetime,
    canEdit: true,
    onStarted: noop,
  });
  if (controls.cancelRequested) return null;
  return (
    <RoundButton testID={props.testID} size="small" display="inverted" title={t('workflows.transcriptCard.stopReviewing')}
      loading={controls.pendingControl === 'cancel'} disabled={controls.pendingControl !== null}
      onPress={() => void controls.submitControl('cancel')} />
  );
}

function noop(): void {}

const styles = StyleSheet.create((theme) => ({
  // The row sits in the transcript column exactly like a message: centered, at most the column's width.
  outer: { width: '100%', alignSelf: 'center' },
  container: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  body: { paddingTop: theme.space.s8 },
}));
