import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';
import type {
  WorkflowRunPrivateMetadataV1,
  WorkflowRunStartResultV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WorkflowRunFoldHeader } from '@/components/workflows/presentation/WorkflowRunFoldHeader';
import { WorkflowRunStateMark } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
  formatWorkflowRunDisplayName,
  resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { useWorkflowInlineRunControls } from '@/components/workflows/run/useWorkflowInlineRunControls';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  describeWorkflowRunState,
  isTerminalWorkflowRunState,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

type DiscussionWorkflowRunProps = Readonly<{
  run: WorkflowRunSummaryV1;
  metadata: WorkflowRunPrivateMetadataV1 | null | undefined;
  supportsAnotherRound: boolean | undefined;
  canEdit: boolean;
  accountLifetime: ServerAccountScopeLifetime;
  /** The new round stays here: the list re-reads and shows it under its message. */
  onStarted: (result: WorkflowRunStartResultV1) => void;
  /** The committed replies this Run published here, in thread order. */
  publishedMessageIds: readonly string[];
  /** Save as pattern from this finished Run's replies; the Discussion's one capture controller. */
  onSaveAsPattern: (messageIds: readonly string[]) => void;
}>;

/** What the Run is and how it stands, as the header line reads it: the name, its state, then its answers or progress. */
function useRunLine(props: Pick<DiscussionWorkflowRunProps, 'run' | 'metadata' | 'publishedMessageIds'> & Readonly<{ cancelRequested?: boolean }>) {
  const { run, metadata } = props;
  const answerCount = props.publishedMessageIds.length;
  return React.useMemo(() => {
    const lifecycle = describeWorkflowRunState(run.state, {
      workflowCustodyState: run.workflowCustodyState,
      inAttentionWindow: run.attentionRequired,
      cancelRequested: props.cancelRequested,
    });
    const progress = describeWorkflowRunProgress(run.stepProgress);
    const finished = isTerminalWorkflowRunState(run.state);
    return {
      verb: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(metadata)),
      lifecycle: lifecycle.label,
      // The lifecycle word already says "Needs you" while the Run waits on the person.
      details: [lifecycle.label, ...(finished
        ? answerCount > 0 ? [t('workflows.start.answerCount', { count: answerCount })] : []
        : progress ? [progress] : [])],
    };
  }, [answerCount, metadata, props.cancelRequested, run.attentionRequired, run.state, run.stepProgress, run.workflowCustodyState]);
}

/**
 * A Pattern run started from this Discussion, under the message that started it (lab T4 FD): the shared
 * Run band names it and its state, and Open goes to the full Run. Replies arrive as ordinary attributed
 * messages; this row never repeats them.
 *
 * The Run's own operations (Another round, Save as pattern) live in exactly one place: on the end row
 * after its last published reply when the timeline placed one (`endRow`), otherwise on this header
 * (a live Run, or a finished one with nothing published here).
 */
export const DiscussionWorkflowRunRow = React.memo(function DiscussionWorkflowRunRow(
  props: DiscussionWorkflowRunProps & Readonly<{ endRow?: boolean }>,
) {
  return props.endRow === true
    ? <DiscussionWorkflowRunHeader {...props} actions={null} refusal={null} />
    : <DiscussionWorkflowRunWithControls {...props} placement="header" />;
});

/** The quiet row that closes a finished Run after its last published reply: Another round and Save as pattern. */
export const DiscussionWorkflowRunEndRow = React.memo(function DiscussionWorkflowRunEndRow(props: DiscussionWorkflowRunProps & Readonly<{
  /** How far the thread's reply text stands in from its row edge (past the speaker face): the end row starts there. */
  replyTextInset: number;
}>) {
  return <DiscussionWorkflowRunWithControls {...props} placement="end" />;
});

function DiscussionWorkflowRunWithControls(props: DiscussionWorkflowRunProps & Readonly<{ placement: 'header' | 'end'; replyTextInset?: number }>) {
  const { theme } = useUnistyles();
  const controls = useWorkflowInlineRunControls({
    run: props.run,
    definition: null,
    acceptedContext: null,
    supportsAnotherRound: props.supportsAnotherRound,
    accountLifetime: props.accountLifetime,
    canEdit: props.canEdit,
    onStarted: props.onStarted,
  });
  const runId = props.run.id;
  const pending = controls.start.pendingRunId !== null && controls.start.isPending(controls.start.pendingRunId);
  const anotherRound = controls.anotherRound;
  const { publishedMessageIds, onSaveAsPattern } = props;
  const savePattern = React.useCallback(() => onSaveAsPattern(publishedMessageIds), [onSaveAsPattern, publishedMessageIds]);
  const canSavePattern = isTerminalWorkflowRunState(props.run.state) && publishedMessageIds.length > 0;
  const operationPending = pending || controls.pendingControl !== null;
  const pause = props.canEdit && controls.availability.pause ? (
    <SectionActionButton
      testID={`discussion-workflow-run-pause:${runId}`}
      title={t('workflows.run.pauseAtBoundary')}
      icon="pause-circle"
      disabled={operationPending}
      loading={controls.pendingControl === 'pause'}
      onPress={() => void controls.submitControl('pause')}
    />
  ) : null;
  const stop = props.canEdit && controls.availability.cancel ? (
    <ToolbarButton
      testID={`discussion-workflow-run-stop:${runId}`}
      label={controls.pendingControl === 'cancel' ? t('workflows.run.stopping')
        : controls.cancelRequested ? t('workflows.run.stopAgain') : t('workflows.run.stop')}
      icon={<Icon name="stop" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
      destructive
      disabled={operationPending}
      busy={controls.pendingControl === 'cancel'}
      onPress={() => void controls.submitControl('cancel')}
    />
  ) : null;
  const another = anotherRound ? (
    <ToolbarButton
      testID={`discussion-workflow-run-another-round:${runId}`}
      label={t('workflows.start.anotherRound')}
      icon={<Icon name="arrows-clockwise" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
      disabled={operationPending}
      busy={pending}
      onPress={() => void anotherRound()}
    />
  ) : null;
  const save = canSavePattern ? (
    // Quiet beside the bordered Another round (lab T4 FD): keeping the replies is the rarer step.
    <SectionActionButton
      testID={`discussion-workflow-run-save-pattern:${runId}`}
      title={t('workflows.start.capture.title')}
      icon="bookmark"
      onPress={savePattern}
    />
  ) : null;
  const refusal = controls.controlError ? (
    <SurfaceStateCard
      testID={`discussion-workflow-run-control-error:${runId}`}
      size="line"
      kind="error"
      accessibilitySemantics={controls.controlError.accessibilitySemantics}
      title={controls.controlError.title}
      reason={controls.controlError.message}
    />
  ) : controls.start.refusal ? (
    <SurfaceStateCard
      testID={`discussion-workflow-run-refusal:${runId}`}
      size="line"
      kind="error"
      accessibilitySemantics="status"
      title={controls.start.refusal.message}
    />
  ) : null;
  if (props.placement === 'header') {
    return <DiscussionWorkflowRunHeader {...props} cancelRequested={controls.cancelRequested}
      actions={pause || stop || another || save ? <>{pause}{stop}{another}{save}</> : null} refusal={refusal} />;
  }
  return <DiscussionWorkflowRunEnd {...props} actions={<>{another}{save}</>} refusal={refusal} />;
}

function DiscussionWorkflowRunHeader(props: DiscussionWorkflowRunProps & Readonly<{
  cancelRequested?: boolean;
  actions: React.ReactNode;
  refusal: React.ReactNode;
}>) {
  const router = useRouter();
  const column = useLayoutMaxWidthStyle();
  const serverId = props.accountLifetime.scope.serverId;
  const runId = props.run.id;
  const open = React.useCallback(() => {
    router.push(createWorkflowRunRoute(runId, serverId) as Href);
  }, [router, runId, serverId]);
  const line = useRunLine(props);
  const presentation = React.useMemo(() => ({ verb: line.verb, details: line.details, meta: null, purpose: null }), [line]);
  return (
    <View style={[styles.outer, column]} testID={`discussion-workflow-run:${runId}`}>
      <View style={styles.container}>
        <WorkflowRunFoldHeader runId={runId} disclosure={null} presentation={presentation} onOpen={open} actions={props.actions} />
        {props.refusal}
      </View>
    </View>
  );
}

function DiscussionWorkflowRunEnd(props: DiscussionWorkflowRunProps & Readonly<{
  replyTextInset?: number;
  actions: React.ReactNode;
  refusal: React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const column = useLayoutMaxWidthStyle();
  const line = useRunLine(props);
  const { createdAt, finishedAt } = props.run;
  const elapsedMs = finishedAt === null ? Number.NaN : Date.parse(finishedAt) - Date.parse(createdAt);
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? formatElapsedDuration(elapsedMs) : null;
  const runId = props.run.id;
  return (
    <View style={[styles.outer, column]} testID={`discussion-workflow-run-end:${runId}`}>
      <View style={[styles.endContainer, { paddingLeft: theme.space.s16 + (props.replyTextInset ?? 0) }]}>
        <View style={styles.end}>
          {/* Which run these act on, in the thread's quiet meta voice: the replies above can be several runs'. */}
          <View style={styles.endSummary}>
            <WorkflowRunStateMark state={props.run.state}
              context={{ workflowCustodyState: props.run.workflowCustodyState }} size={ICON_SIZE.xs} />
            <Text style={styles.endLine} numberOfLines={2}>
              {[line.verb, line.lifecycle, ...(elapsed ? [elapsed] : [])].join(' · ')}
            </Text>
          </View>
          <View style={styles.endActions}>{props.actions}</View>
        </View>
        {props.refusal}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // As the Session fold: centered in the thread column, at most its width.
  outer: { width: '100%', alignSelf: 'center' },
  container: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
    gap: theme.space.s4,
  },
  // Under the last reply, on the replies' text edge: no band, the actions carry it.
  endContainer: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s6,
    paddingBottom: theme.space.s12,
    gap: theme.space.s4,
  },
  end: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s12,
    rowGap: theme.space.s6,
  },
  // The summary takes the line's free width, which puts the actions at its end; on a phone they wrap
  // beneath it and start on the reply's text edge.
  endSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  endLine: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  endActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
