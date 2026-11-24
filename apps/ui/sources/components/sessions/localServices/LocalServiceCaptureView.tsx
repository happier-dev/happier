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
} from '@happier-dev/plugins-telemetry/capture-views';
import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
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
  type TelemetryCaptureReads,
} from '@/components/projects/deployments/telemetryCaptureReads';
import {
  serverAccountScopeKeySuffix,
  type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import { getPreferredLanguage, t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';

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
type StatusRead =
  | Readonly<{
      reads: TelemetryCaptureReads;
      kind: 'ready';
      status: CaptureStatus;
    }>
  | Readonly<{ reads: TelemetryCaptureReads; kind: 'failed'; code: string }>;

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
            code: telemetryCaptureFailureCode(error),
          });
      },
    );
    return () => controller.abort();
  }, [active, reads, attempt]);
  const status = statusRead?.reads === reads ? statusRead : null;
  const enabled =
    status?.kind === 'ready' ? status.status.enabled !== false : null;
  const [openTrace, setOpenTrace] = React.useState<Readonly<{
    reads: TelemetryCaptureReads;
    request: DatabaseCaptureSummaryV1;
  }> | null>(null);
  const trace = view === 'traces' && openTrace?.reads === reads ? openTrace : null;
  const { state, more, refresh } = useTelemetryCaptureList(
    lifetime,
    reads,
    active && enabled === true && !trace,
    view,
    WINDOW_MS[windowId],
  );
  const retry = React.useCallback(() => {
    setAttempt(value => value + 1);
    void refresh?.();
  }, [refresh]);
  const openRequest = React.useCallback(
    (request: DatabaseCaptureSummaryV1) => {
      if (reads) setOpenTrace({ reads, request });
    },
    [reads],
  );
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
        alertActionFailure({
          code: telemetryCaptureFailureCode(error),
          reason: t('deploymentTelemetry.local.turnOnFailed'),
        });
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
        alertActionFailure({ code, reason: failure });
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
        alertActionFailure({ code, reason: t('deploymentTelemetry.menu.clearFailed') });
      return;
    }
    if (lifetime?.isCurrent()) retry();
  }, [lifetime, reads, retry]);

  const coverageReason =
    status?.kind === 'ready' ? status.status.coverage.reason : null;
  const ready = status?.kind === 'ready' ? status.status : null;
  const missed = ready && ready.coverage.lostObservations > 0
    ? t('deploymentTelemetry.local.missed', { count: ready.coverage.lostObservations }) : null;
  const statusText =
    enabled === false
      ? t('deploymentTelemetry.local.off')
      : ready?.preparing
        ? t('deploymentTelemetry.local.preparing')
        : coverageReason
          ? [t('deploymentTelemetry.local.gaps', {
              reason: coverageReason.replaceAll('_', ' '),
            }), missed].filter(Boolean).join(' · ')
          : enabled
            ? t('deploymentTelemetry.local.on')
            : null;
  const restartRequired =
    status?.kind === 'ready' && status.status.restartRequired === true;

  const data = state.data;
  const failed = state.failure !== null && !state.reading;
  const body =
    status === null ? (
      <SurfaceStateCard
        testID={`${testID}-reading`}
        kind="loading"
        size="line"
        title={t('common.loading')}
      />
    ) : status.kind === 'failed' ? (
      <SurfaceStateCard
        testID={`${testID}-unavailable`}
        kind="unavailable"
        title={t('deploymentTelemetry.unavailable.title')}
        diagnosticCode={status.code}
        action={{
          label: t('common.retry'),
          onPress: retry,
          testID: `${testID}-retry`,
        }}
      />
    ) : enabled === false ? (
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
    ) : failed && data === null ? (
      <SurfaceStateCard
        testID={`${testID}-unavailable`}
        kind="unavailable"
        title={t('deploymentTelemetry.unavailable.title')}
        diagnosticCode={state.failure}
        action={{
          label: t('common.retry'),
          onPress: retry,
          testID: `${testID}-retry`,
        }}
      />
    ) : trace ? (
      <TelemetryRequestDetail
        reads={trace.reads}
        lifetime={lifetime}
        active={active}
        request={trace.request}
        locale={locale}
        onBack={() => setOpenTrace(null)}
      />
    ) : data && data.items.length === 0 && !state.reading ? (
      <SurfaceStateCard
        testID={`${testID}-waiting`}
        kind="empty"
        iconName="globe"
        title={t('deploymentTelemetry.local.waitingTitle')}
        reason={t('deploymentTelemetry.local.waitingBody')}
      />
    ) : data?.list === 'endpoints' ? (
      <CaptureEndpoints
        items={data.items}
        loading={state.reading}
        locale={locale}
        more={
          data.nextCursor ? { onPress: more, busy: state.loadingMore } : null
        }
      />
    ) : data?.list === 'traces' ? (
      <CaptureTraces
        items={data.items}
        loading={state.reading}
        locale={locale}
        onOpen={openRequest}
        more={
          data.nextCursor ? { onPress: more, busy: state.loadingMore } : null
        }
      />
    ) : data?.list === 'logs' ? (
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
            reason={t('deploymentTelemetry.local.restartReason')}
            action={{
              label: t('deploymentTelemetry.local.servers'),
              onPress: props.onShowServers,
            }}
          />
        ) : null}
        {failed && data !== null ? (
          <SurfaceFreshnessLine
            testID={`${testID}-stale`}
            tone="warning"
            asOf={state.readAt}
            reason={`${t('deploymentTelemetry.unavailable.title')} · ${t('deploymentTelemetry.unavailable.reason')}`}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        ) : null}
        {enabled ? (
          <View style={styles.bar}>
            <Text
              variant="meta"
              numberOfLines={1}
              testID={`${testID}-status`}
              style={coverageReason ? styles.gaps : styles.facts}
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
                  setOpenTrace(null);
                }}
              />
              <TelemetryMenu onRetry={coverageReason ? retryCapture : null} onTurnOff={turnOff} onClear={clear}
                testID={`${testID}-menu`} />
            </View>
          </View>
        ) : null}
      </View>
      <CoreCollectionScope>{body}</CoreCollectionScope>
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
  gaps: { color: theme.colors.state.warning.foreground, flexShrink: 1 },
}));
