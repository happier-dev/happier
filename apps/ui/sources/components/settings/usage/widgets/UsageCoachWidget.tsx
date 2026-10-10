import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type {
  UsageCoachConceptEvaluation,
  UsageCoachDetectorId,
  UsageCoachFinding,
  UsageCoachDigestSuggestion,
} from '@happier-dev/protocol/usage/coach/coachFinding';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { TriggerPopover } from '@/components/workflows/triggers/TriggerPopover';
import { TriggerRunsOnRow } from '@/components/workflows/triggers/TriggerRunsOnRow';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import type { UsageCoachRemedy } from '@happier-dev/protocol/usage/coach/coachRemedy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  type UsageBodyProps,
} from './usageBodyKit';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
import {
  createUsageCoachController,
  type UsageCoachAppliedEntry,
  type UsageCoachController,
  type UsageCoachSnapshot,
} from './usageCoachController';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DETECTOR_GLYPHS: Readonly<Record<UsageCoachDetectorId, IconName>> = {
  duplicated_instructions: 'file-text',
  model_misfit: 'cpu',
  idle_recaching: 'timer',
  approval_friction: 'hand',
  mcp_overhead: 'plug',
  repeated_file_reads: 'eye',
  compaction_storms: 'arrows-in',
  anomalous_looping_usage: 'repeat',
  cache_busting_prompt_changes: 'arrows-clockwise',
  outside_usage: 'terminal',
  context_bloat: 'stack',
};
const EMPTY_SNAPSHOT: UsageCoachSnapshot = {
  pending: [],
  applied: [],
  digest: null,
  hiddenEvidenceKeys: [],
  error: null,
  approval: null,
  retired: true,
};

function formatMeasurement(
  measurement: UsageCoachFinding['measurements'][number],
): string {
  const value =
    measurement.unit === 'currency'
      ? formatUsageCost(measurement.value, measurement.currency ?? 'USD')
      : measurement.unit === 'bytes'
        ? formatByteSize(measurement.value)
        : measurement.unit === 'tokens'
          ? formatTokenCount(measurement.value)
          : measurement.unit === 'milliseconds'
            ? formatUsageDuration(measurement.value)
            : new Intl.NumberFormat().format(measurement.value);
  return `${value} ${t(`usage.board.coach.metric_${measurement.metric}`)}`;
}

function remedyLabel(remedy: UsageCoachRemedy): string {
  switch (remedy.kind) {
    case 'setting':
      return t('usage.board.coach.apply_setting');
    case 'model':
      return t('usage.board.coach.apply_model');
    case 'mcp_binding':
      return remedy.enabled
        ? t('usage.board.coach.apply_mcp_on')
        : t('usage.board.coach.apply_mcp_off');
    case 'prepared_session':
      return t('usage.board.coach.apply_prepared_session');
    case 'recovery':
      return t('usage.board.coach.apply_recovery');
  }
}

function appliedLabel(entry: UsageCoachAppliedEntry): string {
  if (entry.undone) return t('usage.board.coach.undone');
  if (entry.result.spawnedSessionId)
    return t('usage.board.coach.sessionStarted');
  if (entry.result.reversalUnavailableReason === 'no_change')
    return t('usage.board.coach.noChange');
  if (!entry.result.reversal) return t('usage.board.coach.notReversible');
  return t('usage.board.coach.applied');
}

/** One mounted controller per captured Home/Account; it holds only what this person just did. */
function useUsageCoachController(
  onSettled: () => void,
): Readonly<{
  controller: UsageCoachController | null;
  snapshot: UsageCoachSnapshot;
}> {
  const viewer = useActiveServerAccountScope();
  const lifetime = React.useMemo(
    () => captureActiveServerAccountScopeLifetime(),
    [viewer?.serverId, viewer?.accountId],
  );
  const settled = React.useRef(onSettled);
  settled.current = onSettled;
  const [controller, setController] =
    React.useState<UsageCoachController | null>(null);
  React.useEffect(() => {
    if (!lifetime) {
      setController(null);
      return;
    }
    const created = createUsageCoachController({
      lifetime,
      onSettled: () => settled.current(),
    });
    setController(created);
    return () => created.dispose();
  }, [lifetime]);
  const subscribe = React.useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => {}),
    [controller],
  );
  const read = React.useCallback(
    () => controller?.getSnapshot() ?? EMPTY_SNAPSHOT,
    [controller],
  );
  const snapshot = React.useSyncExternalStore(subscribe, read, read);
  return { controller, snapshot };
}

/**
 * Coach: each evidence-backed finding with what was seen, how complete it is and, only where an owner
 * admitted one, its Apply and exact Undo. Insufficient evidence is a visible result, never a finding.
 */
export function UsageCoachWidget(props: UsageBodyProps) {
  const coach = props.slice.coach;
  const { refresh } = props.model;
  const { controller, snapshot } = useUsageCoachController(refresh);
  const [showChecks, setShowChecks] = React.useState(false);
  const nowMs = Date.now();
  useWidgetFrameBodyCaption(
    coach
      ? t('usage.board.coach.caption', {
          checks: coach.evaluations.length,
          period: usagePeriodPhrase(props.query),
        })
      : null,
  );
  if (!coach)
    return (
      <View style={styles.body}>
        <UsageBodyInsufficient
          testID={`${props.testID}.unavailable`}
          title={t('usage.board.coach.unavailableTitle')}
        />
        <UsageCoverageLine
          slice={props.slice}
          sources={['how_you_work', 'accounting']}
          onRetry={refresh}
          testID={`${props.testID}.coverage`}
        />
      </View>
    );
  const hidden = new Set(snapshot.hiddenEvidenceKeys);
  const visible = coach.findings.filter(
    (finding) =>
      !hidden.has(finding.evidenceKey) &&
      !finding.state.dismissed &&
      !(
        finding.state.snoozedUntilMs !== null &&
        finding.state.snoozedUntilMs > nowMs
      ),
  );
  const appliedOnly = snapshot.applied.filter(
    (entry) =>
      !visible.some((finding) => finding.evidenceKey === entry.evidenceKey),
  );
  const insufficient = coach.evaluations.filter(
    (
      row,
    ): row is Extract<
      UsageCoachConceptEvaluation,
      { status: 'insufficient_evidence' }
    > => row.status === 'insufficient_evidence',
  );
  const clear = coach.evaluations.filter((row) => row.status === 'no_finding');
  const summary = [
    t('usage.board.coach.findingsCount', { count: visible.length }),
    ...(insufficient.length
      ? [
          t('usage.board.coach.insufficientCount', {
            count: insufficient.length,
          }),
        ]
      : []),
    ...(clear.length
      ? [t('usage.board.coach.clearCount', { count: clear.length })]
      : []),
  ].join(' · ');
  const row = (finding: UsageCoachFinding) => (
    <UsageCoachFindingRow
      key={finding.evidenceKey}
      finding={finding}
      applied={
        snapshot.applied.find(
          (entry) => entry.evidenceKey === finding.evidenceKey,
        ) ?? null
      }
      controller={controller}
      snapshot={snapshot}
      query={props.slice.requestedQuery}
      testID={`${props.testID}.finding.${finding.detectorId}`}
    />
  );
  return (
    <View style={styles.body} testID={`${props.testID}.coach`}>
      <UsageCoachSummaryLine text={summary} />
      {visible.length === 0 && appliedOnly.length === 0 ? (
        <SurfaceStateCard
          testID={`${props.testID}.empty`}
          kind="empty"
          layout="inline"
          size="line"
          title={t('usage.board.coach.emptyTitle')}
          reason={t('usage.board.coach.emptyReason')}
        />
      ) : null}
      <View style={styles.list}>
        {visible.map(row)}
        {appliedOnly.map((entry) => row(entry.finding))}
      </View>
      {insufficient.length + clear.length > 0 ? (
        <UsageCoachChecks
          open={showChecks}
          onToggle={() => setShowChecks((open) => !open)}
          insufficient={insufficient}
          clear={clear}
          testID={`${props.testID}.checks`}
        />
      ) : null}
      {coach.digestSuggestion ? (
        <UsageCoachDigestSuggestionRow
          key={coach.digestSuggestion.queryKey}
          suggestion={coach.digestSuggestion}
          controller={controller}
          snapshot={snapshot}
          serverId={props.serverId}
          testID={`${props.testID}.digest`}
        />
      ) : null}
      <UsageCoverageLine
        slice={props.slice}
        sources={['how_you_work', 'accounting']}
        onRetry={refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

/** The suggestion chooses no cadence or destination; the existing trigger editor owns those choices. */
function UsageCoachDigestSuggestionRow(props: Readonly<{
  suggestion: UsageCoachDigestSuggestion;
  controller: UsageCoachController | null;
  snapshot: UsageCoachSnapshot;
  serverId: string;
  testID: string;
}>) {
  const router = useRouter();
  const metrics = usePageRowMetrics('list');
  const anchorRef = React.useRef<View>(null);
  const [editing, setEditing] = React.useState(false);
  const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
  const { suggestion, controller, snapshot } = props;
  const pending = snapshot.pending.some(row => row.evidenceKey === suggestion.queryKey);
  const approval = snapshot.approval?.evidenceKey === suggestion.queryKey ? snapshot.approval : null;
  const error = snapshot.error?.evidenceKey === suggestion.queryKey;
  const created = snapshot.digest?.queryKey === suggestion.queryKey ? snapshot.digest.result : null;
  const subtitle = { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight };
  return (
    <View style={styles.checks} testID={props.testID} accessibilityState={{ busy: pending }}>
      <Text style={[styles.title, { fontSize: metrics.title.fontSize, lineHeight: metrics.title.lineHeight }]}
        accessibilityRole="header">{t('usage.board.coach.digestTitle')}</Text>
      <Text style={[styles.evidence, subtitle]}>{t('usage.board.coach.digestDescription', {
        duration: formatUsageDuration(suggestion.lookbackMs),
      })}</Text>
      {approval ? (
        <View style={styles.appliedRow}>
          <RoundButton size="small" display="secondary" title={t('detailPages.approval.requestTitle')}
            testID={`${props.testID}.approval`} action={() => router.push(
              `/inbox/approvals/${encodeURIComponent(approval.request.artifactId)}?serverId=${encodeURIComponent(props.serverId)}`,
            )} />
          <RoundButton size="small" display="secondary" title={t('automations.pluralEditor.triggersTitle')}
            testID={`${props.testID}.manage`} action={() => router.push(resolveTriggerEditorHref({ serverId: props.serverId }))} />
        </View>
      ) : null}
      {error && !editing ? <Text style={[styles.error, subtitle]} testID={`${props.testID}.error`}>
        {t('usage.board.coach.actionFailed')}</Text> : null}
      {created ? (
        <View style={styles.appliedRow}>
          <Text style={[styles.applied, subtitle]}>{t('usage.board.coach.digestCreated')}</Text>
          <RoundButton size="small" display="secondary" title={t('automations.pluralEditor.triggersTitle')}
            testID={`${props.testID}.manage`} action={() => router.push(resolveTriggerEditorHref({
              automationId: created.set.automationId, serverId: props.serverId,
              scopeSessionId: created.set.scopeSessionId,
            }))} />
        </View>
      ) : (
        <View ref={anchorRef} style={styles.actionsBelow}>
          <RoundButton size="small" display="secondary" title={t('usage.board.coach.digestConfigure')}
            testID={`${props.testID}.configure`} disabled={!controller || snapshot.retired || pending}
            action={() => setEditing(true)} />
        </View>
      )}
      {editing ? (
        <TriggerPopover anchorRef={anchorRef} onRequestClose={() => setEditing(false)}
          testID={`${props.testID}.editor`} whenKinds={['schedule']} sessionId={null} initial={null}
          workflowOptions={[]} showThen={false} newTitle={t('usage.board.coach.digestTitle')}
          submitLabel={t('usage.board.coach.digestCreate')} serverId={props.serverId} machineId={project?.machineId}
          hostComplete={project !== null && controller !== null && !snapshot.retired}
          setRows={<TriggerRunsOnRow target={project} onChange={setProject} testID={`${props.testID}.project`}
            description={t('workflows.triggers.editor.runsOnDescription')} />}
          onSubmit={async (_value, write) => {
            if (!controller || !project || write.trigger?.kind !== 'schedule') throw new Error(t('usage.board.coach.actionFailed'));
            const result = await controller.createDigest(suggestion, project, write.trigger);
            if (!result.ok) throw new Error(t('usage.board.coach.actionFailed'));
            setEditing(false);
          }}
        />
      ) : null}
    </View>
  );
}

function UsageCoachSummaryLine(props: Readonly<{ text: string }>) {
  const metrics = usePageRowMetrics('list');
  return (
    <Text
      style={[
        styles.summary,
        {
          fontSize: metrics.subtitle.fontSize,
          lineHeight: metrics.subtitle.lineHeight,
        },
      ]}
    >
      {props.text}
    </Text>
  );
}

const UsageCoachFindingRow = React.memo(function UsageCoachFindingRow(
  props: Readonly<{
    finding: UsageCoachFinding;
    applied: UsageCoachAppliedEntry | null;
    controller: UsageCoachController | null;
    snapshot: UsageCoachSnapshot;
    query: UsageBodyProps['query'];
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('standard');
  const presentation = useWidgetPresentation();
  const wide = (presentation?.geometry?.width ?? 0) >= 560;
  const { finding, applied, controller, snapshot } = props;
  const pending = snapshot.pending.some(
    (row) => row.evidenceKey === finding.evidenceKey,
  );
  const error =
    snapshot.error?.evidenceKey === finding.evidenceKey ? snapshot.error : null;
  const approval = snapshot.approval?.evidenceKey === finding.evidenceKey;
  const title = t(`usage.board.coach.summary_${finding.summaryCode}`);
  const evidence = [
    ...finding.measurements.map(formatMeasurement),
    t('usage.board.coach.evidenceLine', {
      count: finding.evidence.length,
      coverage: t(`usage.board.coach.coverage_${finding.coverage}`),
    }),
    ...(finding.currentness === 'stale'
      ? [t('usage.board.coach.staleEvidence')]
      : []),
    ...(finding.asOfMs !== null
      ? [t('surfaceState.asOf', { time: formatAsOfTime(finding.asOfMs) })]
      : []),
  ].join(' · ');
  const estimate = finding.estimate;
  const estimateValue = estimate
    ? estimate.unit === 'currency'
      ? formatUsageCost(estimate.value, estimate.currency ?? 'USD')
      : formatByteSize(estimate.value)
    : null;
  const canApply =
    finding.action !== null &&
    finding.remedy !== null &&
    finding.currentness === 'current' &&
    (!applied || applied.undone);
  const glyphColor =
    finding.severity === 'warning'
      ? theme.colors.state.warning.foreground
      : theme.colors.text.secondary;
  const text = (size: 'title' | 'subtitle') => ({
    fontSize: metrics[size].fontSize,
    lineHeight: metrics[size].lineHeight,
  });
  const action =
    canApply && controller ? (
      <RoundButton
        size="small"
        display="secondary"
        testID={`${props.testID}.apply`}
        title={remedyLabel(finding.remedy!)}
        disabled={pending}
        action={() => controller.apply(props.query, finding)}
      />
    ) : applied && !applied.undone && applied.result.reversal && controller ? (
      <View style={styles.appliedRow}>
        <Icon
          name="check"
          size={ICON_SIZE.sm}
          color={theme.colors.state.success.foreground}
        />
        <Text style={[styles.applied, text('subtitle')]}>
          {appliedLabel(applied)}
        </Text>
        <RoundButton
          size="small"
          display="secondary"
          testID={`${props.testID}.undo`}
          title={t('usage.board.coach.undo')}
          disabled={pending}
          action={() => controller.undo(finding.evidenceKey)}
        />
      </View>
    ) : applied ? (
      <View style={styles.appliedRow}>
        <Icon
          name="check"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text style={[styles.applied, text('subtitle')]}>
          {appliedLabel(applied)}
        </Text>
      </View>
    ) : finding.remedy === null ? (
      <Text style={[styles.quiet, text('subtitle')]}>
        {t('usage.board.coach.noRemedy')}
      </Text>
    ) : null;
  return (
    <View
      style={[styles.row, wide ? styles.rowWide : null]}
      testID={props.testID}
      accessibilityState={{ busy: pending }}
    >
      <View
        style={styles.glyph}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon
          name={DETECTOR_GLYPHS[finding.detectorId]}
          size={ICON_SIZE.md}
          color={glyphColor}
        />
      </View>
      <View style={styles.main}>
        <Text style={[styles.category, text('subtitle')]}>
          {t(`usage.board.coach.detector_${finding.detectorId}`)}
        </Text>
        <Text style={[styles.title, text('title')]} accessibilityRole="header">
          {title}
        </Text>
        <Text style={[styles.evidence, text('subtitle')]}>{evidence}</Text>
        {estimate && estimateValue ? (
          <Text style={[styles.estimate, text('subtitle')]}>
            {t(`usage.board.coach.estimate_${estimate.kind}`, {
              value: estimateValue,
            })}
            <Text
              style={styles.quiet}
            >{` · ${t(`usage.board.coach.method_${estimate.method}`)}`}</Text>
          </Text>
        ) : null}
        {approval ? (
          <Text style={[styles.pendingNote, text('subtitle')]}>
            {t('usage.board.coach.approvalPending')}
          </Text>
        ) : null}
        {error ? (
          <Text
            style={[styles.error, text('subtitle')]}
            testID={`${props.testID}.error`}
          >
            {error.actionId === 'usage.coach.undo' &&
            error.failure.errorCode.endsWith('conflict')
              ? t('usage.board.coach.undoConflict')
              : t('usage.board.coach.actionFailed')}
          </Text>
        ) : null}
        {wide ? null : <View style={styles.actionsBelow}>{action}</View>}
      </View>
      {wide ? <View style={styles.actionsSide}>{action}</View> : null}
      {controller ? (
        <ItemRowActions
          title={title}
          compactThreshold={Number.POSITIVE_INFINITY}
          overflowTriggerTestID={`${props.testID}.more`}
          overflowTriggerAccessibilityLabel={t(
            'usage.board.coach.findingOptions',
            { title },
          )}
          actions={[
            {
              id: 'dismiss',
              title: t('usage.board.coach.dismiss'),
              icon: 'x',
              disabled: pending,
              onPress: () => {
                void controller.dismiss(props.query, finding.evidenceKey);
              },
            },
            {
              id: 'snooze',
              title: t('usage.board.coach.snoozeWeek'),
              icon: 'bell-slash',
              disabled: pending,
              onPress: () => {
                void controller.snooze(
                  props.query,
                  finding.evidenceKey,
                  Date.now() + WEEK_MS,
                );
              },
            },
          ]}
        />
      ) : null}
    </View>
  );
});

function UsageCoachChecks(
  props: Readonly<{
    open: boolean;
    onToggle: () => void;
    testID: string;
    insufficient: readonly Extract<
      UsageCoachConceptEvaluation,
      { status: 'insufficient_evidence' }
    >[];
    clear: readonly UsageCoachConceptEvaluation[];
  }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('list');
  const size = {
    fontSize: metrics.subtitle.fontSize,
    lineHeight: metrics.subtitle.lineHeight,
  };
  return (
    <View style={styles.checks}>
      <HappierPressable
        accessibilityRole="button"
        testID={`${props.testID}.toggle`}
        expanded={props.open}
        onPress={props.onToggle}
        style={styles.checksToggle}
      >
        <Icon
          name={props.open ? 'caret-down' : 'caret-right'}
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        <Text style={[styles.checksToggleLabel, size]}>
          {props.open
            ? t('usage.board.coach.hideChecks')
            : t('usage.board.coach.showChecks')}
        </Text>
      </HappierPressable>
      {props.open ? (
        <View style={styles.checksList} testID={`${props.testID}.list`}>
          {props.insufficient.map((row) => (
            <View key={row.detectorId} style={styles.checkRow}>
              <Icon
                name={DETECTOR_GLYPHS[row.detectorId]}
                size={ICON_SIZE.sm}
                color={theme.colors.text.tertiary}
              />
              <Text style={[styles.checkText, size]}>
                <Text style={styles.checkName}>
                  {t(`usage.board.coach.detector_${row.detectorId}`)}
                </Text>
                {` · ${t('usage.board.coach.insufficientRow', {
                  missing: row.missingEvidence
                    .map((capability) =>
                      t(`usage.board.coach.capability_${capability}`),
                    )
                    .join(', '),
                })}`}
              </Text>
            </View>
          ))}
          {props.clear.map((row) => (
            <View key={row.detectorId} style={styles.checkRow}>
              <Icon
                name={DETECTOR_GLYPHS[row.detectorId]}
                size={ICON_SIZE.sm}
                color={theme.colors.text.tertiary}
              />
              <Text style={[styles.checkText, size]}>
                <Text style={styles.checkName}>
                  {t(`usage.board.coach.detector_${row.detectorId}`)}
                </Text>
                {` · ${t('usage.board.coach.noFinding')}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 12, minWidth: 0 },
  summary: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  list: { gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  rowWide: { alignItems: 'center' },
  glyph: { paddingTop: 2 },
  main: { flex: 1, minWidth: 0, gap: 2 },
  category: { ...Typography.default(), color: theme.colors.text.tertiary },
  title: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  evidence: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  estimate: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  quiet: { ...Typography.default(), color: theme.colors.text.tertiary },
  pendingNote: {
    ...Typography.default(),
    color: theme.colors.state.warning.foreground,
  },
  error: {
    ...Typography.default(),
    color: theme.colors.state.danger.foreground,
  },
  actionsBelow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  actionsSide: { flexShrink: 0, alignItems: 'flex-end' },
  appliedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  applied: { ...Typography.default(), color: theme.colors.text.secondary },
  checks: { gap: 6 },
  checksToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  checksToggleLabel: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  checksList: { gap: 6 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  checkText: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flex: 1,
  },
  checkName: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
}));
