import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  DatabaseCaptureStatusResultV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';
import {
  CaptureEndpoints,
  CaptureLogs,
  CaptureTraces,
  type CaptureListDetail,
} from '@happier-dev/plugins-telemetry/capture-views';
import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import {
  TelemetryMenu,
  TelemetryRequestDetail,
  useTelemetryCaptureList,
} from '@/components/projects/deployments/DeploymentTelemetryPanel';
import {
  TelemetryCaptureTransportContext,
  createTelemetryCaptureReads,
  telemetryCaptureFailureCode,
  telemetryCaptureFailure,
  type TelemetryCaptureReads,
} from '@/components/projects/deployments/telemetryCaptureReads';
import {
  serverAccountScopeKeySuffix,
  type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import { getPreferredLanguage, t } from '@/text';
import { alertActionFailure, formatActionFailureDetails, showActionFailureDetails } from '@/utils/errors/alertActionFailure';

import { useLocalServiceActionRunner } from './localServiceActionOutcome';

function alertCaptureFailure(error: unknown, reason: string): void {
  alertActionFailure({ ...telemetryCaptureFailure(error), reason });
}

export type LocalServiceCaptureViewId = 'endpoints' | 'traces' | 'logs';

/** The checkout whose capture is read: the Project's admitted checkout, on the Machine that runs it. */
export type LocalServiceCaptureWorktree = Readonly<{
  machineId: string;
  projectId: string;
  workspaceId: string;
}>;

type WindowId = 'quarter' | 'hour' | 'day';
const WINDOW_MS: Readonly<Record<WindowId, number>> = {
  quarter: 900_000,
  hour: 3_600_000,
  day: 86_400_000,
};

type CaptureStatus = Extract<DatabaseCaptureStatusResultV1, { ok: true }>;
/** What the view's body shows: the one decision the time window and the status line follow. */
type CaptureBodyKind = 'reading' | 'unavailable' | 'off' | 'waiting' | 'list';

/** Tells the view whether the open request's detail is the page (pushed on a phone), from the Collection's own fact. */
function DetailIsPageReporter(props: Readonly<{ isPage: boolean; onChange: (isPage: boolean) => void }>): null {
  const { isPage, onChange } = props;
  React.useLayoutEffect(() => {
    onChange(isPage);
    return () => onChange(false);
  }, [isPage, onChange]);
  return null;
}
type StatusRead =
  | Readonly<{
      reads: TelemetryCaptureReads;
      kind: 'ready';
      status: CaptureStatus;
    }>
  | Readonly<{ reads: TelemetryCaptureReads; kind: 'failed'; failure: ReturnType<typeof telemetryCaptureFailure> }>;

/**
 * A worktree's Endpoints, Traces and Logs on its Dev servers page (P5 F7, lab dbCapture). The same capture reads and
 * views an Environment's Telemetry tab uses, with this checkout as their source. Off, the view says what it would
 * show and offers the one switch; Queries stay in Database Insights.
 */
export function LocalServiceCaptureView(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    worktree: LocalServiceCaptureWorktree;
    view: LocalServiceCaptureViewId;
    active: boolean;
    machineName: string;
    onShowServers: () => void;
    restartSelectedService?: Readonly<{ name: string; run: () => Promise<unknown> }>;
    testID: string;
  }>,
): React.ReactElement {
  const { lifetime, worktree, view, active, testID } = props;
  const styles = stylesheet;
  const locale = getPreferredLanguage();
  const { invoke } = React.useContext(TelemetryCaptureTransportContext);
  const { machineId, projectId, workspaceId } = worktree;
  const reads = React.useMemo(
    () =>
      lifetime
        ? createTelemetryCaptureReads(invoke, {
            scope: lifetime.scope,
            collectorMachineId: machineId,
            worktree: { projectId, workspaceId },
          })
        : null,
    [invoke, lifetime, machineId, projectId, workspaceId],
  );
  const [windowId, setWindowId] = React.useState<WindowId>('hour');
  const [attempt, setAttempt] = React.useState(0);
  const [statusRead, setStatusRead] = React.useState<StatusRead | null>(null);
  React.useEffect(() => {
    if (!active || !reads) return;
    const controller = new AbortController();
    reads.status(controller.signal).then(
      (status) => {
        if (!controller.signal.aborted)
          setStatusRead({ reads, kind: 'ready', status });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setStatusRead({
            reads,
            kind: 'failed',
            failure: telemetryCaptureFailure(error),
          });
      },
    );
    return () => controller.abort();
  }, [active, reads, attempt]);
  const status = statusRead?.reads === reads ? statusRead : null;
  const enabled =
    status?.kind === 'ready' ? status.status.enabled !== false : null;
  // The trace the person opened beside Traces; the first one is shown until they pick (`CaptureTraces` detail).
  const [openTraceId, setOpenTraceId] = React.useState<string | null>(null);
  const { state, more, refresh } = useTelemetryCaptureList(
    lifetime,
    reads,
    active && enabled === true,
    view,
    WINDOW_MS[windowId],
  );
  const retry = React.useCallback(() => {
    setAttempt(value => value + 1);
    void refresh?.();
  }, [refresh]);
  const serviceAction = useLocalServiceActionRunner();
  const selected = props.restartSelectedService;
  const restarting = serviceAction.pendingId === 'restart';
  const restart = async () => {
    if (!selected || restarting) return;
    if (await serviceAction.run({
      id: 'restart',
      serviceName: selected.name,
      failureTitle: t('localServices.actions.failureTitle.restart', { service: selected.name }),
      action: selected.run,
    })) retry();
  };
  const traceDetail = React.useMemo<CaptureListDetail<DatabaseCaptureSummaryV1>>(() => ({
    openId: openTraceId,
    onOpenChange: setOpenTraceId,
    render: (request, context) => reads ? (
      <>
        <DetailIsPageReporter isPage={context.pushed} onChange={setDetailIsPage} />
        <TelemetryRequestDetail key={request.id} reads={reads} lifetime={lifetime} active={active} request={request}
          locale={locale} />
      </>
    ) : null,
  }), [openTraceId, reads, lifetime, active, locale]);
  const readLogBody = React.useCallback(
    (id: string) =>
      active && reads
        ? reads.logBody(id)
        : Promise.reject(new Error('telemetry_unavailable')),
    [active, reads],
  );
  // A held Turn on is the person's approval request: the shared approval owner shows it and re-reads once it runs.
  const approval = useActionApprovalContinuation({
    scopeKey: lifetime ? serverAccountScopeKeySuffix(lifetime.scope) : '',
    serverId: lifetime?.scope.serverId ?? '',
    onExecuted: retry,
  });
  const { requestApproval } = approval;
  const [turningOn, setTurningOn] = React.useState(false);
  const turnOn = React.useCallback(async () => {
    if (!reads || turningOn) return;
    setTurningOn(true);
    try {
      const outcome = await reads.configure(true);
      if (!lifetime?.isCurrent()) return;
      if (outcome.kind === 'approval_pending')
        requestApproval(outcome.artifactId);
      else retry();
    } catch (error) {
      if (lifetime?.isCurrent())
        alertCaptureFailure(error, t('deploymentTelemetry.local.turnOnFailed'));
    } finally {
      setTurningOn(false);
    }
  }, [lifetime, reads, requestApproval, retry, turningOn]);

  // Turning capture off and clearing it live here, in the view's "…": capture has one control owner on the page.
  const reconfigure = React.useCallback(async (enabled: boolean, failure: string, options?: Readonly<{ retry: true }>) => {
    if (!reads) return;
    try {
      const outcome = await reads.configure(enabled, options);
      if (!lifetime?.isCurrent()) return;
      if (outcome.kind === 'approval_pending')
        requestApproval(outcome.artifactId);
      else retry();
    } catch (error) {
      const code = telemetryCaptureFailureCode(error);
      if (lifetime?.isCurrent() && code !== 'approval_canceled' && code !== PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE)
        alertCaptureFailure(error, failure);
    }
  }, [lifetime, reads, requestApproval, retry]);
  const turnOff = React.useCallback(
    () => reconfigure(false, t('deploymentTelemetry.local.turnOffFailed')), [reconfigure]);
  const retryCapture = React.useCallback(
    () => reconfigure(true, t('deploymentTelemetry.local.turnOnFailed'), { retry: true }), [reconfigure]);
  const clear = React.useCallback(async () => {
    if (!reads) return;
    try {
      await reads.clear();
    } catch (error) {
      const code = telemetryCaptureFailureCode(error);
      if (lifetime?.isCurrent() && code !== 'approval_canceled' && code !== PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE)
        alertCaptureFailure(error, t('deploymentTelemetry.menu.clearFailed'));
      return;
    }
    if (lifetime?.isCurrent()) retry();
  }, [lifetime, reads, retry]);

  const ready = status?.kind === 'ready' ? status.status : null;
  const coverage = state.coverage ?? ready?.coverage;
  const restartRequired =
    status?.kind === 'ready' && status.status.restartRequired === true;

  const data = state.data;
  const failed = state.failure !== null && !state.reading;
  // The capture's state is said once: an unanswered read says it in the body, gaps and a needed restart in their own
  // line with the next step beside it; the bar says only "Preparing" or "Capture on". The gap's cause is a store
  // code, so the line says what it means for the person (events weren't kept) and offers Retry.
  const gaps = coverage && coverage.lostObservations > 0
    ? t('deploymentTelemetry.local.missed', {
        count: coverage.lostObservations,
        formattedCount: new Intl.NumberFormat(locale).format(coverage.lostObservations),
      })
    : coverage?.reason ? '' : null;
  // One decision for what the view shows: the body draws it, and the time window and status follow it.
  const bodyKind: CaptureBodyKind = status === null
    ? 'reading'
    : status.kind === 'failed'
      ? 'unavailable'
      : enabled === false
        ? 'off'
        : failed && data === null
          ? 'unavailable'
          : data && data.items.length === 0 && !state.reading
            ? 'waiting'
            : data
              ? 'list'
              : 'reading';
  const stale = bodyKind === 'list' && failed;
  // The bar says only "Preparing" or "Capture on", and only when no line already says the capture's state.
  const statusText = stale || gaps !== null || restartRequired
    ? null
    : ready?.preparing
      ? t('deploymentTelemetry.local.preparing')
      : enabled
        ? t('deploymentTelemetry.local.on')
        : null;
  // The time window and "…" stand over the rows, in one place on every tab. They are there while a list is (or is about
  // to be) shown, and give way while one request's detail is the page on a phone: a window does not apply to a single
  // request (lab dbCapture-tracep), nor to a capture that did not answer.
  const [detailIsPage, setDetailIsPage] = React.useState(false);
  const windowShown = enabled === true && bodyKind !== 'unavailable' && bodyKind !== 'off'
    && !(view === 'traces' && detailIsPage);
  const windowBar = (
    <View style={styles.bar}>
      <Text
        variant="meta"
        numberOfLines={1}
        testID={`${testID}-status`}
        style={styles.facts}
      >
        {statusText}
      </Text>
      <View style={styles.barEnd}>
        <SegmentedTabBar<WindowId>
          role="radiogroup"
          accessibilityLabel={t('deploymentTelemetry.window.label')}
          testIDPrefix={`${testID}-window`}
          segmentSizing="content"
          activeTabId={windowId}
          tabs={[
            {
              id: 'quarter',
              label: t('deploymentTelemetry.local.window.quarter'),
            },
            {
              id: 'hour',
              label: t('deploymentTelemetry.local.window.hour'),
            },
            { id: 'day', label: t('deploymentTelemetry.local.window.day') },
          ]}
          onSelectTab={(id) => {
            setWindowId(id);
            setOpenTraceId(null);
          }}
        />
        {/* Retry lives on the gaps line while it shows; the menu keeps the rare moves. */}
        <TelemetryMenu onRestart={selected && !restartRequired ? () => { void restart(); } : null}
          restarting={restarting} onTurnOff={turnOff} onClear={clear} testID={`${testID}-menu`} />
      </View>
    </View>
  );
  const body =
    bodyKind === 'unavailable' ? (
      <SurfaceStateCard
        testID={`${testID}-unavailable`}
        kind="unavailable"
        title={t('deploymentTelemetry.local.unavailableTitle')}
        reason={t('deploymentTelemetry.local.unavailableBody')}
        diagnosticCode={status?.kind === 'failed' ? status.failure.code : state.failure?.code}
        diagnosticDetail={status?.kind === 'failed' ? formatActionFailureDetails(status.failure)
          : state.failure ? formatActionFailureDetails(state.failure) : undefined}
        action={{
          label: t('common.retry'),
          onPress: retry,
          testID: `${testID}-retry`,
        }}
      />
    ) : bodyKind === 'off' ? (
      <SurfaceStateCard
        testID={`${testID}-off`}
        kind="empty"
        scene="nothingListening"
        title={t('deploymentTelemetry.local.offTitle')}
        reason={t('deploymentTelemetry.local.offBody')}
        {...(approval.approvalPending
          ? {}
          : {
              action: {
                label: t('deploymentTelemetry.local.turnOn'),
                onPress: () => {
                  void turnOn();
                },
                testID: `${testID}-turn-on`,
              },
            })}
      />
    ) : bodyKind === 'waiting' ? (
      <SurfaceStateCard
        testID={`${testID}-waiting`}
        kind="empty"
        iconName="globe"
        title={t('deploymentTelemetry.local.waitingTitle')}
        reason={t('deploymentTelemetry.local.waitingBody')}
      />
    ) : bodyKind === 'list' && data?.list === 'endpoints' ? (
      <CaptureEndpoints
        items={data.items}
        loading={state.reading}
        locale={locale}
        more={
          data.nextCursor ? { onPress: more, busy: state.loadingMore } : null
        }
      />
    ) : bodyKind === 'list' && data?.list === 'traces' ? (
      <CaptureTraces
        items={data.items}
        loading={state.reading}
        locale={locale}
        detail={traceDetail}
        more={
          data.nextCursor ? { onPress: more, busy: state.loadingMore } : null
        }
      />
    ) : bodyKind === 'list' && data?.list === 'logs' ? (
      <CaptureLogs
        items={data.items}
        loading={state.reading}
        locale={locale}
        readBody={readLogBody}
        more={
          data.nextCursor ? { onPress: more, busy: state.loadingMore } : null
        }
      />
    ) : (
      <SurfaceStateCard
        testID={`${testID}-reading`}
        kind="loading"
        size="line"
        title={t('common.loading')}
      />
    );

  return (
    <View style={styles.root} testID={testID}>
      {/* The view is the section: it stands on the sheet edge and spaces its parts, so a banner or a sheet inside
          (the approval notice, the Logs sheet) starts where the table and the lines start (DBW services M1). */}
      <SectionLeadingColumnProvider>
      {approval.approvalPending ? (
        <ActionApprovalPendingNotice
          testID={`${testID}-approval`}
          presentation="banner"
          message={t('approvals.waitingForYou')}
          summary={approval.approvalSummary}
          onOpenApproval={approval.openApproval}
        />
      ) : null}
      <View style={styles.lines}>
        {restartRequired ? (
          <SurfaceFreshnessLine
            testID={`${testID}-restart`}
            tone="warning"
            emphasis={t('deploymentTelemetry.local.restart')}
            // The line's owner draws `emphasis` inside `reason`: what to do, then why.
            reason={`${t('deploymentTelemetry.local.restart')} ${t('deploymentTelemetry.local.restartReason')}`}
            action={selected ? {
              label: t('localServices.actions.restartTitle'),
              busy: restarting,
              disabled: restarting,
              onPress: () => { void restart(); },
            } : {
              label: t('deploymentTelemetry.local.openServers'),
              onPress: props.onShowServers,
            }}
          />
        ) : null}
        {gaps !== null ? (
          <SurfaceFreshnessLine
            testID={`${testID}-gaps`}
            tone="warning"
            emphasis={t('deploymentTelemetry.local.gaps')}
            // The line's owner draws `emphasis` inside `reason`: the state leads, then what it cost.
            reason={[t('deploymentTelemetry.local.gaps'), gaps].filter(Boolean).join(' · ')}
            action={{ label: t('common.retry'), onPress: () => { void retryCapture(); } }}
          />
        ) : null}
        {stale ? (
          <SurfaceFreshnessLine
            testID={`${testID}-stale`}
            tone="warning"
            asOf={state.readAt}
            reason={t('deploymentTelemetry.local.stale')}
            actions={[
              { label: t('common.retry'), onPress: retry },
              ...(state.failure ? [{ label: t('approvals.technicalDetails'),
                onPress: () => { if (state.failure) showActionFailureDetails(state.failure); },
                testID: `${testID}-failure-details` }] : []),
            ]}
          />
        ) : null}
        {windowShown ? windowBar : null}
      </View>
      <CoreCollectionScope>{body}</CoreCollectionScope>
      </SectionLeadingColumnProvider>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  // The view draws the page's sheet edge itself: its Collection, on a page column, takes that edge as drawn
  // (CoreCollectionScope), so the table and the lines above it share the sheet edge of the page's other sections.
  root: { gap: theme.space.s12, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  lines: { gap: theme.space.s12 },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  barEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  facts: { color: theme.colors.text.secondary, flexShrink: 1 },
}));
