import * as React from 'react';
import { useDeviceType } from '@/utils/platform/responsive';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { ChartDatum, formatHappierDataExactShare, formatHappierDataValue, HappierDataMetric, HappierPressable, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import type {
  UsageCoachConceptEvaluation,
  UsageCoachDetectorId,
  UsageCoachFinding,
  UsageCoachDigestSuggestion,
} from '@happier-dev/protocol/usage/coach/coachFinding';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { TriggerPopover } from '@/components/workflows/triggers/TriggerPopover';
import { useOpenNewSession } from '@/components/sessions/new/navigation/newSessionEntry';
import { TriggerRunsOnRow } from '@/components/workflows/triggers/TriggerRunsOnRow';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { UsageCoachRemedy } from '@happier-dev/protocol/usage/coach/coachRemedy';
import { countUsageCheckedSessions } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import { Item } from '@/components/ui/lists/Item';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { UsagePlanDisclosure } from './plans/UsagePlanParts';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { UsageCoachSettingsGroup } from '../UsageCoachSettingsGroup';
import {
  UsageBodyInsufficient,
  UsageBodyReading,
  UsageCoverageLine,
  UsageShowAllRows,
  leadingUsageRows,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { formatUsageDuration, formatUsageDurationExact, formatUsageLookbackPeriod } from './usageHowYouWorkPresentation';
import {
  createUsageCoachController,
  type UsageCoachAppliedEntry,
  type UsageCoachController,
  type UsageCoachSnapshot,
} from './usageCoachController';
import { projectUsageCoachFindings, projectUsageCoachTrend, readUsageCoachFailureMessage, readUsageCoachState } from './usageCoachPresentation';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useUsageDisclosureCommand } from './usageMountedControls';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this body width the Overview strip's three columns would crush their titles; it lists instead. */
const STRIP_MIN_WIDTH_PX = 760;
const STRIP_FINDINGS = 3;
/** On Overview, at the strip's width, the Coach is three findings in a row; its loading state holds that room. */
export function isUsageCoachStrip(presentation: ReturnType<typeof useWidgetPresentation>): boolean {
  return presentation?.size !== undefined && presentation.size !== 'large'
    && (presentation.geometry?.width ?? 0) >= STRIP_MIN_WIDTH_PX;
}
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
  cache_economics: 'arrows-clockwise',
  effort_audit: 'cpu',
  subagent_fanout: 'stack',
};
const EMPTY_SNAPSHOT: UsageCoachSnapshot = {
  pending: [],
  applied: [],
  digest: null,
  error: null,
  approval: null,
  retired: true,
};

/** The finding's own line names its leading measurements; every measurement stays listed under Why. */
const COACH_LINE_MEASUREMENTS = 3;

function formatExactCoachValue(value: number, unit: UsageCoachFinding['measurements'][number]['unit'], currency?: string): string {
  return unit === 'currency' ? `${currency ?? 'USD'} ${formatHappierDataValue(value, getPreferredLanguage())}`
    : unit === 'milliseconds' ? formatUsageDurationExact(value)
      : unit === 'bytes' ? new Intl.NumberFormat(getPreferredLanguage(), { style: 'unit', unit: 'byte', maximumSignificantDigits: 15 }).format(value)
        : formatHappierDataValue(value, getPreferredLanguage());
}

function formatMeasurement(
  measurement: UsageCoachFinding['measurements'][number],
  precision?: 'exact',
): string {
  if (precision === 'exact') {
    const value = measurement.metric === 'cache_hit_ratio' ? formatHappierDataExactShare(measurement.value, getPreferredLanguage())
      : formatExactCoachValue(measurement.value, measurement.unit, measurement.currency);
    return `${value} ${t(`usage.board.coach.metric_${measurement.metric}`)}`;
  }
  const value =
    measurement.unit === 'currency'
      ? formatUsageCost(measurement.value, measurement.currency ?? 'USD')
      : measurement.unit === 'bytes'
        ? formatHappierDataBytes(measurement.value, { kind: 'storage' })
        : measurement.unit === 'tokens'
          ? formatTokenCount(measurement.value)
          : measurement.unit === 'milliseconds'
            ? formatUsageDuration(measurement.value)
            : measurement.metric === 'cache_hit_ratio'
              // A ratio reads as the share it is ("0% of input from cache"), never a bare "0".
              ? `${Math.round(measurement.value * 100)}%`
              : new Intl.NumberFormat().format(measurement.value);
  return `${value} ${t(`usage.board.coach.metric_${measurement.metric}`)}`;
}

function measurementHidesPrecision(measurement: UsageCoachFinding['measurements'][number]) {
  const value = measurement.unit === 'milliseconds' ? measurement.value / 1000
    : measurement.metric === 'cache_hit_ratio' ? measurement.value * 100 : measurement.value;
  return !formatMeasurement(measurement).includes(formatHappierDataValue(value, getPreferredLanguage()));
}

/** One point per 5 px of the 180 px trend column: a dense series reads as its envelope, not a solid block. */
const TREND_POINTS = 36;

/**
 * The finding's own measured samples (lab d2coach-A mini chart): its first series as a quiet line with its
 * largest sample under it (acceptance 11-21 #12). A single sample is one observation, not a trend, so it draws nothing.
 */
function UsageCoachFindingTrend(props: Readonly<{ finding: UsageCoachFinding; testID: string }>) {
  const chartTheme = useUsagePluginTheme();
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('standard');
  const sample = props.finding.evidenceSeries?.find(entry => entry.points.length > 1);
  const trend = React.useMemo(() => sample ? projectUsageCoachTrend(sample, TREND_POINTS) : null, [sample]);
  if (!sample || !trend) return null;
  // The headline measurement is the finding's own figure; this line names the series' peak and when it was seen.
  // The value and its moment take a line each, and the value wraps rather than truncate in this narrow column.
  const peak = t('usage.board.coach.peakSample', { value: formatMeasurement({ ...sample, value: trend.peak.value }) });
  const observedAt = formatUsageObservedAt(trend.peak.observedAtMs);
  const caption = `${peak} · ${observedAt}`;
  const line = { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight };
  return (
    <View style={styles.trend} testID={props.testID}>
      <StackedSeriesChart theme={chartTheme} variant="line" size="inline" viewportHeight={24} label={caption}
        series={[{ id: sample.metric, label: caption, color: theme.colors.text.secondary, points: trend.points }]} />
      <View accessible accessibilityLabel={caption}>
        <Text style={[styles.quiet, line]} numberOfLines={2}>{peak}</Text>
        <Text style={[styles.quiet, line]} numberOfLines={1}>{observedAt}</Text>
      </View>
    </View>
  );
}

/** A citation reads as its site; the full address stays in its accessible name and opens on press. */
function readCitationHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatModelResponseSource(source: NonNullable<UsageCoachFinding['modelComparison']>['modelResponseSource']): string {
  if (source?.kind === 'native' && source.connectedAccount) {
    const { service, accountId } = source.connectedAccount;
    return `${service.pluginId}/${service.localId} · ${accountId}`;
  }
  if (source?.kind === 'provider') {
    return `${source.providerId ?? t('usage.board.coach.modelProviderUnknown')} · ${source.providerConnectionId}`;
  }
  return t('usage.board.coach.modelProviderUnknown');
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
  const approvals = useActionApprovalContinuation({
    scopeKey: JSON.stringify([viewer?.serverId ?? null, viewer?.accountId ?? null]),
    serverId: viewer?.serverId ?? '',
    onExecuted: () => settled.current(),
  });
  const requestApproval = React.useRef(approvals.requestApproval);
  requestApproval.current = approvals.requestApproval;
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
      onApproval: (registration) => requestApproval.current(registration),
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

/** A finding's own outcome line: a failed Action says so (announced), a waiting approval says it is waiting. */
function CoachNotice(props: Readonly<{ kind: 'error' | 'pending'; message: string; testID?: string }>) {
  const { theme } = useUnistyles();
  const line = props.kind === 'error' ? (
    <NoticeLine testID={props.testID ?? 'usage-coach-error'} iconName="warning"
      iconColor={theme.colors.state.danger.foreground} title={props.message} />
  ) : (
    <NoticeLine testID={props.testID ?? 'usage-coach-approval-pending'} iconName="info"
      iconColor={theme.colors.text.secondary} title={props.message} />
  );
  return props.kind === 'error' ? <View accessibilityRole="alert">{line}</View> : line;
}

/**
 * Coach: each evidence-backed finding with what was seen, how complete it is and, only where an owner
 * admitted one, its Apply and exact Undo. Insufficient evidence is a visible result, never a finding.
 */
export function UsageCoachWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const presentation = useWidgetPresentation();
  const coach = props.slice.coach;
  const { refresh } = props.model;
  const { controller, snapshot } = useUsageCoachController(refresh);
  const openNewSession = useOpenNewSession();
  // Anywhere but its own view (size Large) the Coach is a glance: up to three findings, the rest of
  // the Coach (hidden, checks, digest, preferences) stays on the Coach view.
  const glance = presentation?.size !== undefined && presentation.size !== 'large';
  const strip = isUsageCoachStrip(presentation);
  const reading = readUsageCoachState(props.slice) === 'reading';
  // When a read's coverage names no count, the period's own Sessions read is the same fact the Overview shows.
  // Preferences are rare: a quiet disclosure after the findings, never a bar above them (lab d2coach).
  const configuration = <UsagePlanDisclosure title={t('usage.board.coach.configure')} testID={`${props.testID}.configure`}>
    <UsageCoachSettingsGroup serverId={props.serverId} testID={`${props.testID}.preferences`} />
  </UsagePlanDisclosure>;
  const nowMs = Date.now();
  useWidgetFrameBodyCaption(
    coach
      ? t('usage.board.coach.caption', {
          checks: coach.evaluations.filter(row => row.status !== 'disabled').length,
          period: usagePeriodPhrase(props.query),
        })
      : usagePeriodPhrase(props.query),
  );
  if (!coach)
    return (
      <View style={styles.body}>
          <UsageBodyInsufficient
            testID={`${props.testID}.unavailable`}
            title={t('usage.board.coach.unavailableTitle')}
          />
          {configuration}
          <UsageCoverageLine
            slice={props.slice}
            sources={['how_you_work', 'accounting']}
            onRetry={refresh}
            testID={`${props.testID}.coverage`}
          />
      </View>
    );
  const { visible, suppressed, appliedOnly } = projectUsageCoachFindings(coach.findings, snapshot, nowMs);
  const insufficient = coach.evaluations.filter(
    (
      row,
    ): row is Extract<
      UsageCoachConceptEvaluation,
      { status: 'insufficient_evidence' }
    > => row.status === 'insufficient_evidence',
  );
  const clear = coach.evaluations.filter((row) => row.status === 'no_finding');
  const disabled = coach.evaluations.filter(row => row.status === 'disabled');
  // Nothing was actually checked: every check still waits for evidence. That is a first use, not "nothing needs you",
  // and the way forward is work for the Coach to read.
  const firstUse = insufficient.length > 0 && clear.length === 0;
  // What the checks found, as one row of facts (lab d2coach "This week"). Savings are never summed:
  // overlapping estimates would double count, so the band counts findings and checks only.
  const checked = coach.evaluations.length - disabled.length;
  // The band holds only what is known (owner ruling 11-13: unknown is never the lead row). Listed findings are
  // counted from the list itself, even while another source still reads; an unread check is not one that needs
  // more evidence, and an unknown session count leaves the band rather than standing in it as a dash.
  const sessionsChecked = reading ? undefined : countUsageCheckedSessions(coach.sessionCoverage);
  const summary = [
    ...(!reading || visible.length > 0 ? [{ key: 'findings', label: t('usage.board.coach.summaryFindings'), value: visible.length,
      caption: t('usage.board.coach.summaryOfChecks', { count: checked }) }] : []),
    ...(sessionsChecked !== undefined ? [{ key: 'sessions', label: t('usage.board.coach.summarySessions'), value: sessionsChecked,
      caption: usagePeriodPhrase(props.query) }] : []),
    ...(!reading ? [{ key: 'insufficient', label: t('usage.board.coach.summaryNeedEvidence'), value: insufficient.length,
      caption: clear.length ? t('usage.board.coach.summaryClearCaption', { count: clear.length }) : undefined }] : []),
    ...(disabled.length ? [{ key: 'disabled', label: t('usage.board.coach.summaryOff'), value: disabled.length }] : []),
  ];
  // On Overview the Coach is a strip of up to three findings (lab wgusage-CD); its own view lists all.
  const shown = glance ? visible.slice(0, STRIP_FINDINGS) : visible;
  const row = (finding: UsageCoachFinding) => (
    <UsageCoachFindingRow
      key={finding.evidenceKey}
      finding={finding}
      layout={strip ? 'card' : 'row'}
      evaluationAsOfMs={coach.asOfMs}
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
        {/* The facts band belongs to the Coach view; the Overview strip is the findings alone (lab wgusage-CD). */}
        {glance || summary.length === 0 ? null : <UsageCoachSummaryBand facts={summary} testID={`${props.testID}.summary`} />}
        {visible.length === 0 && appliedOnly.length === 0 ? (
          reading ? <UsageBodyReading testID={`${props.testID}.loading`} {...(strip ? { shape: { kind: 'strip' as const } } : {})} /> :
          firstUse ? <UsageBodyInsufficient
            testID={`${props.testID}.empty`}
            replacesContent={false}
            title={t('usage.board.coach.firstUseTitle')}
            {...(glance ? {} : { reason: t('usage.board.coach.firstUseReason'),
              action: { label: t('usage.board.coach.firstUseAction'), onPress: () => openNewSession() } })}
          /> :
          <SurfaceStateCard
            testID={`${props.testID}.empty`}
            kind="empty"
            layout="inline"
            size="line"
            title={t('usage.board.coach.emptyTitle')}
            // "Every check ran" is only true when none is waiting for evidence. The Coach view's facts band already
            // counts the checks that need more evidence, so only the Overview strip (no band) says it here.
            reason={insufficient.length
              ? glance ? t('usage.board.coach.insufficientCount', { count: insufficient.length }) : undefined
              : t('usage.board.coach.emptyReason')}
          />
        ) : null}
        {/* No findings, no container: an empty one still takes the body's row gap, which grew the reading state past its settled height. */}
        {shown.length > 0 || (!glance && appliedOnly.length > 0) ? <View style={strip ? styles.strip : styles.list}>
          {strip ? shown.map((finding, index) => <React.Fragment key={finding.evidenceKey}>
            {index > 0 ? <View style={styles.stripRule} /> : null}
            {row(finding)}
          </React.Fragment>) : shown.map(row)}
          {glance ? null : appliedOnly.map((entry) => row(entry.finding))}
        </View> : null}
        {glance && visible.length > shown.length ? <Text style={styles.quiet}>
          {t('usage.board.coach.moreFindings', { count: visible.length - shown.length })}</Text> : null}
        {!glance && suppressed.length ? <UsagePlanDisclosure testID={`${props.testID}.hidden`}
          title={t('usage.board.coach.hiddenFindings', { count: suppressed.length })}>
          {suppressed.map(finding => <View key={finding.evidenceKey} style={styles.hiddenRow}>
            <Icon name={DETECTOR_GLYPHS[finding.detectorId]} size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
            <View style={styles.hiddenText}>
              <Text style={styles.checkName} numberOfLines={2}>{t(`usage.board.coach.summary_${finding.summaryCode}`)}</Text>
              <Text style={styles.quiet}>{finding.state.snoozedUntilMs !== null && finding.state.snoozedUntilMs > nowMs
                ? t('usage.board.coach.hiddenSnoozed', { time: formatAsOfTime(finding.state.snoozedUntilMs) })
                : t('usage.board.coach.hiddenDismissed')}</Text>
            </View>
            <RoundButton size="small" display="secondary" testID={`${props.testID}.hidden.${finding.detectorId}.restore`}
              title={t('common.restore')} disabled={!controller || snapshot.retired || snapshot.pending.some(row => row.evidenceKey === finding.evidenceKey)}
              action={async () => {
                if (!controller) return;
                if (finding.state.snoozedUntilMs !== null && finding.state.snoozedUntilMs > nowMs) {
                  await controller.snooze(props.query, finding.evidenceKey, null);
                } else {
                  await controller.dismiss(props.query, finding.evidenceKey, false);
                }
              }} />
            {snapshot.error?.evidenceKey === finding.evidenceKey ? <CoachNotice kind="error" message={t('usage.board.coach.actionFailed')} /> : null}
            {snapshot.approval?.evidenceKey === finding.evidenceKey ? <CoachNotice kind="pending" message={t('usage.board.coach.approvalPending')} /> : null}
          </View>)}
        </UsagePlanDisclosure> : null}
        {!glance && insufficient.length + clear.length > 0 ? (
          <UsageCoachChecks
            insufficient={insufficient}
            clear={clear}
            testID={`${props.testID}.checks`}
          />
        ) : null}
        {!glance && coach.digestSuggestion ? (
          <UsageCoachDigestSuggestionRow
            key={coach.digestSuggestion.queryKey}
            suggestion={coach.digestSuggestion}
            controller={controller}
            snapshot={snapshot}
            serverId={props.serverId}
            testID={`${props.testID}.digest`}
          />
        ) : null}
        {glance ? null : configuration}
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
  const canConfigure = controller !== null && !snapshot.retired && !pending;
  const commands = useCurrentUiContextLocalCommands([
    ...(!created && canConfigure ? [{ key: 'configure', title: t('usage.board.coach.digestConfigure'),
      invoke: () => setEditing(true) }] : []),
    ...(editing ? [{ key: 'close', title: `${t('usage.board.coach.digestTitle')}: ${t('common.close')}`,
      invoke: () => setEditing(false) }] : []),
    ...(approval ? [{ key: 'approval', title: t('detailPages.approval.requestTitle'), invoke: () => {
      router.push(`/inbox/approvals/${encodeURIComponent(approval.request.artifactId)}?serverId=${encodeURIComponent(props.serverId)}`);
    } }] : []),
    ...(approval || created ? [{ key: 'manage', title: t('automations.pluralEditor.triggersTitle'), invoke: () => {
      router.push(resolveTriggerEditorHref({ serverId: props.serverId,
        ...(created ? { automationId: created.set.automationId, scopeSessionId: created.set.scopeSessionId } : {}) }));
    } }] : []),
  ], { contextKey: suggestion.queryKey });
  const subtitle = { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight };
  return (
    // A quiet offer on one line beside its action, not a second section inside the widget (QA-V F19).
    <View style={styles.digest} testID={props.testID} accessibilityState={{ busy: pending }}>
      <View style={styles.digestText}>
        <Text style={[styles.checkName, subtitle]} accessibilityRole="header">{t('usage.board.coach.digestTitle')}</Text>
        <Text style={[styles.quiet, subtitle]}>{t('usage.board.coach.digestDescription', {
          duration: formatUsageLookbackPeriod(suggestion.lookbackMs),
        })}</Text>
      </View>
      {approval ? (
        <View style={styles.appliedRow}>
          <RoundButton size="small" display="secondary" title={t('detailPages.approval.requestTitle')}
            testID={`${props.testID}.approval`} onPress={() => { void commands.invoke('approval'); }} />
          <RoundButton size="small" display="secondary" title={t('automations.pluralEditor.triggersTitle')}
            testID={`${props.testID}.manage`} onPress={() => { void commands.invoke('manage'); }} />
        </View>
      ) : null}
      {error && !editing ? <CoachNotice kind="error" testID={`${props.testID}.error`} message={t('usage.board.coach.actionFailed')} /> : null}
      {created ? (
        <View style={styles.appliedRow}>
          <Text style={[styles.applied, subtitle]}>{t('usage.board.coach.digestCreated')}</Text>
          <RoundButton size="small" display="secondary" title={t('automations.pluralEditor.triggersTitle')}
            testID={`${props.testID}.manage`} onPress={() => { void commands.invoke('manage'); }} />
        </View>
      ) : (
        <View ref={anchorRef} style={styles.appliedRow}>
          <RoundButton size="small" display="secondary" title={t('usage.board.coach.digestConfigure')}
            testID={`${props.testID}.configure`} disabled={!canConfigure}
            onPress={() => { void commands.invoke('configure'); }} />
        </View>
      )}
      {editing ? (
        <TriggerPopover anchorRef={anchorRef} onRequestClose={() => { void commands.invoke('close'); }}
          currentUiContextCommandScope={`${props.testID}.editor`}
          testID={`${props.testID}.editor`} whenKinds={['schedule']} sessionId={null} initial={null}
          workflowOptions={[]} showThen={false} newTitle={t('usage.board.coach.digestTitle')}
          submitLabel={t('usage.board.coach.digestCreate')} serverId={props.serverId} machineId={project?.machineId}
          hostComplete={project !== null && controller !== null && !snapshot.retired}
          setRows={<TriggerRunsOnRow target={project} onChange={setProject} testID={`${props.testID}.project`}
            currentUiContextCommandScope={`${props.testID}.project`}
            description={t('workflows.triggers.editor.runsOnDescription')} />}
          onSubmit={async (_value, write, context) => {
            if (!controller || !project || write.trigger?.kind !== 'schedule') throw new Error(t('usage.board.coach.actionFailed'));
            const result = await controller.createDigest(suggestion, project, write.trigger, context);
            if (!result.ok) throw new Error(t('usage.board.coach.actionFailed'));
            setEditing(false);
          }}
        />
      ) : null}
    </View>
  );
}

function UsageCoachSummaryBand(props: Readonly<{ facts: readonly Readonly<{ key: string; label: string; value: number | string; caption?: string }>[]; testID: string }>) {
  const chartTheme = useUsagePluginTheme();
  return (
    <View style={styles.band} testID={props.testID}>
      {props.facts.map(fact => (
        <View key={fact.key} style={styles.bandFact}>
          <HappierDataMetric theme={chartTheme} size="stat" showLabel label={fact.label} value={fact.value}
            {...(fact.caption ? { caption: fact.caption } : {})} testID={`${props.testID}.${fact.key}`} />
        </View>
      ))}
    </View>
  );
}

/** A finding's next step when it is a decision the person makes elsewhere: one navigation row, also a page command. */
function UsageCoachNextStep(props: Readonly<{ testID: string }>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const title = t('usage.board.coach.nextStep_approval_friction');
  const commands = useCurrentUiContextLocalCommands([{ key: 'open', title,
    invoke: () => { router.push(SETTINGS_ROUTES.permissions as Parameters<typeof router.push>[0]); return true; } }]);
  return <Item testID={props.testID} title={title} icon={<Icon name="shield-check" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
    onPress={() => { void commands.invoke('open'); }} />;
}

const UsageCoachFindingRow = React.memo(function UsageCoachFindingRow(
  props: Readonly<{
    finding: UsageCoachFinding;
    /** `row` lists findings (the Coach view); `card` is one of the Overview strip's columns. */
    layout: 'row' | 'card';
    /** The evaluation's own read time, which the page header already says ("As of …"). */
    evaluationAsOfMs: number | null;
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
  // Until the frame measures the body, a full-width cell is already wide, so the row is drawn at its final shape
  // (trend in place) on first paint and never settles when the measurement lands (R141).
  const phone = useDeviceType() === 'phone';
  const measuredWidth = presentation?.geometry?.width;
  const wide = props.layout === 'row' && (measuredWidth !== undefined ? measuredWidth >= 560
    : presentation?.footprint?.width === 'full' && !phone);
  const { finding, applied, controller, snapshot } = props;
  // A finding can rest on hundreds of observations: Why leads with a few and folds the rest behind Show all.
  const [evidenceExpanded, setEvidenceExpanded] = React.useState(false);
  const ledEvidence = leadingUsageRows(finding.evidence, evidenceExpanded);
  const pending = snapshot.pending.some(
    (row) => row.evidenceKey === finding.evidenceKey,
  );
  const error =
    snapshot.error?.evidenceKey === finding.evidenceKey ? snapshot.error : null;
  const approval = snapshot.approval?.evidenceKey === finding.evidenceKey;
  const title = t(`usage.board.coach.summary_${finding.summaryCode}`);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const toggleOptions = useUsageDisclosureCommand(t('usage.board.coach.findingOptions', { title }), optionsOpen,
    () => setOptionsOpen(value => !value), controller !== null);
  const comparison = finding.modelComparison;
  const qualifiedModel = comparison ? [t('usage.board.coach.modelQualified', {
    model: comparison.modelId, candidate: comparison.candidateModelId,
    cost: formatUsageCost(comparison.modelCost, comparison.currency),
    candidateCost: formatUsageCost(comparison.candidateCost, comparison.currency),
    provider: `${comparison.modelId}: ${formatModelResponseSource(comparison.modelResponseSource)}; ${comparison.candidateModelId}: ${formatModelResponseSource(comparison.candidateResponseSource)}`,
  }), t('usage.board.coach.modelN1Cache')].join(' ') : null;
  // The finding's line is what was measured (lab d2coach-A: kind, headline, one line, value, action). How it
  // was established (observation count, coverage, an older reading's time) is method, said under Why.
  // An older reading's time is said on the line only when it differs from the page's own "As of" (USAGE-ACCEPT #9).
  const ownAsOf = finding.asOfMs === null ? null : formatAsOfTime(finding.asOfMs);
  const pageAsOf = props.evaluationAsOfMs === null ? null : formatAsOfTime(props.evaluationAsOfMs);
  const evidence = [
    ...finding.measurements.slice(0, COACH_LINE_MEASUREMENTS).map(measurement => formatMeasurement(measurement)),
    ...(finding.currentness === 'stale' && ownAsOf !== null && ownAsOf !== pageAsOf
      ? [t('surfaceState.asOf', { time: ownAsOf })]
      : []),
  ].join(' · ');
  const method = [
    t('usage.board.coach.evidenceLine', {
      count: finding.evidence.length,
      coverage: t(`usage.board.coach.coverage_${finding.coverage}`),
    }),
    ...(finding.currentness !== 'stale' && finding.asOfMs !== null
      ? [t('surfaceState.asOf', { time: formatAsOfTime(finding.asOfMs) })]
      : []),
  ].join(' · ');
  const estimate = finding.estimate;
  const estimateValue = estimate
    ? estimate.unit === 'currency'
      ? formatUsageCost(estimate.value, estimate.currency ?? 'USD')
      : formatHappierDataBytes(estimate.value, { kind: 'storage' })
    : null;
  const withEstimateDetail = (visual: React.ReactNode) => estimate && estimateValue
    && !estimateValue.includes(formatHappierDataValue(estimate.value, getPreferredLanguage()))
    ? <ChartDatum testID={`${props.testID}.estimate.detail`} datum={{ label: t(`usage.board.coach.estimate_${estimate.kind}`, { value: '' }),
      value: formatExactCoachValue(estimate.value, estimate.unit, estimate.currency),
      subtitle: [t(`usage.board.coach.method_${estimate.method}`), ...estimate.assumptions].join(' · ') }}>{visual}</ChartDatum> : visual;
  const withModelDetail = (visual: React.ReactNode) => comparison && [comparison.modelCost, comparison.candidateCost].some(value =>
    !formatUsageCost(value, comparison.currency).includes(formatHappierDataValue(value, getPreferredLanguage())))
    ? <ChartDatum testID={`${props.testID}.model.detail`} datum={{ label: title,
      value: `${comparison.modelId}: ${formatExactCoachValue(comparison.modelCost, 'currency', comparison.currency)} · ${comparison.candidateModelId}: ${formatExactCoachValue(comparison.candidateCost, 'currency', comparison.currency)}`,
      subtitle: qualifiedModel ?? undefined }}>{visual}</ChartDatum> : visual;
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
  const evidenceInk = <Text style={[styles.evidence, text('subtitle')]} testID={`${props.testID}.meta`}>{evidence}</Text>;
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
    ) : null;
  return (
    <View
      style={[styles.row, wide ? styles.rowWide : null, props.layout === 'card' ? styles.card : null]}
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
        {qualifiedModel ? withModelDetail(<Text style={[styles.evidence, text('subtitle')]}>{qualifiedModel}</Text>) : null}
        {evidence ? finding.measurements.slice(0, COACH_LINE_MEASUREMENTS).some(measurementHidesPrecision)
          ? <ChartDatum testID={`${props.testID}.meta.detail`} datum={{ label: title,
            value: finding.measurements.slice(0, COACH_LINE_MEASUREMENTS).map(measurement => formatMeasurement(measurement, 'exact')).join(' · '),
            subtitle: method }}>{evidenceInk}</ChartDatum> : evidenceInk : null}
        {/* Approval friction has no Apply by design: its next step is the page where the person decides it. */}
        {finding.detectorId === 'approval_friction' && !action ? <UsageCoachNextStep testID={`${props.testID}.nextStep`} /> : null}
        <UsagePlanDisclosure title={t('usage.board.coach.why')} testID={`${props.testID}.why`}>
        <View testID={`${props.testID}.evidence`} style={styles.why}>
          <Text style={[styles.whyHeading, text('subtitle')]}>{t('usage.board.coach.methodTitle')}</Text>
          <Text style={[styles.evidence, text('subtitle')]}>{t(`usage.board.coach.basis_${finding.basis.kind}`)}</Text>
          <Text style={[styles.quiet, text('subtitle')]}>{method}</Text>
          {finding.basis.limitations.map((limitation, index) => <Text key={index} style={[styles.quiet, text('subtitle')]}>{limitation}</Text>)}
          {finding.basis.advice.map((advice, index) => <Text key={index} style={[styles.evidence, text('subtitle')]}>{advice}</Text>)}
          {estimate?.assumptions.map((assumption, index) => <Text key={index} style={[styles.quiet, text('subtitle')]}>{assumption}</Text>)}
          <Text style={[styles.whyHeading, text('subtitle')]}>{t('usage.board.coach.observationsTitle')}</Text>
          <View testID={`${props.testID}.evidence.measurements`}>
            {finding.measurements.map((measurement, index) => {
              const visual = <Text style={[styles.evidence, text('subtitle')]}>{formatMeasurement(measurement)}</Text>;
              return measurementHidesPrecision(measurement) ? <ChartDatum key={index} testID={`${props.testID}.measurement.${index}.detail`}
                datum={{ label: t(`usage.board.coach.metric_${measurement.metric}`), value: formatMeasurement(measurement, 'exact') }}>{visual}</ChartDatum>
                : <React.Fragment key={index}>{visual}</React.Fragment>;
            })}
          </View>
          {ledEvidence.rows.map(reference => <Text key={`${reference.kind}:${reference.id}`}
            testID={`${props.testID}.evidence.${reference.id}`} selectable style={[styles.evidence, text('subtitle')]}>
            {`${t(`usage.board.coach.evidence_${reference.kind}`)} · ${formatWithCachedDateTimeFormatter(reference.observedAtMs, getPreferredLanguage(), {
              year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}`}
          </Text>)}
          <UsageShowAllRows label={t('usage.board.coach.observationsTitle')} testID={`${props.testID}.evidence.showAll`}
            total={finding.evidence.length} hidden={ledEvidence.hidden} expanded={evidenceExpanded}
            onToggle={() => setEvidenceExpanded((value) => !value)} />
          {finding.basis.citations.length ? <Text style={[styles.whyHeading, text('subtitle')]}>{t('usage.board.coach.citationsTitle')}</Text> : null}
          {finding.basis.citations.map(citation => <HappierPressable key={citation.url} accessibilityRole="link"
            accessibilityLabel={`${citation.url}, ${t(`usage.board.coach.citation_${citation.sourceKind}`)}, ${citation.asOf}`} onPress={() => { void openExternalUrl(citation.url); }}>
            <Text style={text('subtitle')} numberOfLines={1}>
              <Text style={styles.link}>{readCitationHost(citation.url)}</Text>
              <Text style={styles.quiet}>{` · ${t(`usage.board.coach.citation_${citation.sourceKind}`)} · ${citation.asOf}`}</Text>
            </Text>
          </HappierPressable>)}
          <UsagePlanDisclosure testID={`${props.testID}.evidence.diagnostics`} title={t('usage.board.coach.diagnostics')}>
            <Text selectable style={[styles.evidence, text('subtitle')]}>{`${t('usage.board.coach.methodTitle')} · ${finding.basis.method}`}</Text>
            {finding.evidence.map(reference => <Text selectable key={`${reference.kind}:${reference.id}`} style={[styles.evidence, text('subtitle')]}>
              {`${t(`usage.board.coach.evidence_${reference.kind}`)} · ${reference.id}`}
            </Text>)}
          </UsagePlanDisclosure>
        </View>
        </UsagePlanDisclosure>
        {!wide && estimate && estimateValue ? (
          withEstimateDetail(<Text style={[styles.estimate, text('subtitle')]}>
            {t(`usage.board.coach.estimate_${estimate.kind}`, {
              value: estimateValue,
            })}
            <Text
              style={styles.quiet}
            >{` · ${t(`usage.board.coach.method_${estimate.method}`)}`}</Text>
          </Text>)
        ) : null}
        {approval ? <CoachNotice kind="pending" message={t('usage.board.coach.approvalPending')} /> : null}
        {error ? (
          <CoachNotice
            kind="error"
            testID={`${props.testID}.error`}
            message={t(readUsageCoachFailureMessage(error))}
          />
        ) : null}
        {wide ? null : <View style={styles.actionsBelow}>{action}</View>}
      </View>
      {/* Wide rows read across: what was found · what was measured · what it costs · what to do (lab d2coach-A). */}
      {wide ? <UsageCoachFindingTrend finding={finding} testID={`${props.testID}.trend`} /> : null}
      {/* Without an estimate the column stays empty (it keeps the row's columns aligned): no unlabeled dash. */}
      {wide ? <View style={styles.impact} testID={`${props.testID}.impact`}>
        {estimate && estimateValue ? <>
          {withEstimateDetail(<Text style={[styles.impactValue, text('title')]}>{estimateValue}</Text>)}
          <Text style={[styles.quiet, text('subtitle')]} numberOfLines={2}>{t(`usage.board.coach.method_${estimate.method}`)}</Text>
        </> : null}
      </View> : null}
      {wide ? <View style={styles.actionsSide}>{action}</View> : null}
      {controller ? (
        <ItemRowActions
          title={title}
          compactThreshold={Number.POSITIVE_INFINITY}
          overflowOpen={optionsOpen}
          onOverflowOpenChange={next => { if (next !== optionsOpen) toggleOptions(); }}
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
    <UsagePlanDisclosure title={t('usage.board.coach.showChecks')} testID={props.testID}>
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
    </UsagePlanDisclosure>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12, minWidth: 0 },
  band: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s24, rowGap: theme.space.s12, paddingBottom: theme.space.s4 },
  bandFact: { minWidth: 112, flexGrow: 1, flexBasis: 0 },
  // The Why panel: method, observations and sources on one quiet rule under the finding.
  why: {
    gap: theme.space.s4,
    marginTop: theme.space.s6,
    paddingLeft: theme.space.s12,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.default,
  },
  whyHeading: { ...Typography.default('semiBold'), color: theme.colors.text.secondary, marginTop: theme.space.s6 },
  link: { ...Typography.default(), color: theme.colors.text.link },
  digest: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s12, rowGap: theme.space.s6 },
  digestText: { flex: 1, minWidth: 220, gap: 1 },
  hiddenRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, paddingVertical: theme.space.s6 },
  hiddenText: { flex: 1, minWidth: 0, gap: 1 },
  list: { gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  // The glyph, trend, impact and menu stay on the finding's head when Why opens and the row grows.
  rowWide: { alignItems: 'flex-start' },
  // Overview strip: equal columns divided by hairlines, no boxes (lab wgusage-CD Coach).
  strip: { flexDirection: 'row', alignItems: 'stretch' },
  card: { flex: 1, minWidth: 0, borderTopWidth: 0, paddingVertical: theme.space.s4 },
  // Columns sit on the card's own inset; a hairline divides neighbours, never the first one.
  stripRule: { width: StyleSheet.hairlineWidth, marginHorizontal: 18, backgroundColor: theme.colors.border.default },
  impact: { width: 120, alignItems: 'flex-end', gap: 1 },
  trend: { width: 180, gap: theme.space.s4, justifyContent: 'center' },

  impactValue: { ...Typography.default('semiBold'), color: theme.colors.state.success.textForeground, fontVariant: ['tabular-nums'] },
  glyph: { paddingTop: theme.space.s2 },
  main: { flex: 1, minWidth: 0, gap: theme.space.s2 },
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
  actionsBelow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s8,
  },
  actionsSide: { flexShrink: 0, alignItems: 'flex-end' },
  appliedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexWrap: 'wrap',
  },
  applied: { ...Typography.default(), color: theme.colors.text.secondary },
  checks: { gap: theme.space.s6 },
  checksList: { gap: theme.space.s6 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
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
