import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type {
  DatabaseCaptureCursorV1,
  DatabaseCaptureEndpointCursorV1,
  DatabaseCaptureEndpointV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';
import { TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 } from '@happier-dev/database-protocol';
import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import {
  CaptureEndpoints,
  CaptureLogs,
  CaptureQueries,
  CaptureTraces,
  CapturedRequestLogs,
  CapturedRequestSlowest,
  CapturedRequestWaterfall,
  captureSummaryFailed,
  requestLabelOf,
  type CaptureEndpointAction,
  type CapturedTraceV1,
} from '@happier-dev/plugins-telemetry/capture-views';
import { formatHappierDuration } from '@happier-dev/plugin-ui/components';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { subjectStarterEventSeed } from '@/components/workflows/triggers/subjectTriggerStarters';
import { AddCheckSetup } from './AddCheckSetup';
import { Typography } from '@/constants/Typography';
import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerScopedMachine, useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getPreferredLanguage, t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { createDeploymentActions } from './deploymentActions';
import { showDeploymentTelemetrySheet } from './DeploymentTelemetrySheet';
import {
  TelemetryCaptureInvokeContext,
  createTelemetryCaptureReads,
  telemetryCaptureFailureCode,
  type TelemetryCaptureList,
  type TelemetryCaptureReads,
} from './telemetryCaptureReads';

/**
 * An Environment's Telemetry tab (P7 J1, P6 F14d). Not set up, it says what telemetry is for and opens the one setup
 * sheet. Set up, it shows what the collector kept for the chosen window: Endpoints, Traces (a row opens its request),
 * Logs and Queries, each one admitted read on the collector while it is open. Settings is in its "…".
 */
export function DeploymentTelemetryPanel(
  props: Readonly<{
    detail: DeploymentEnvironmentDetailV1;
    lifetime: ServerAccountScopeLifetime | null;
    environmentName: string;
    active?: boolean;
    /** Whether the serving native deployment delivered this collector's bindings, when observed. */
    telemetryApplied?: boolean;
    /** Re-read the Environment after a save, so the next save carries its new revision. */
    onChanged: () => void;
  }>,
) {
  const { detail, lifetime } = props;
  const environment = detail.environment;
  const collectorId = environment.telemetryMachineId ?? null;
  const canManage = environment.capabilities.manageBindings;
  const open = React.useCallback(() => {
    if (!lifetime) return;
    showDeploymentTelemetrySheet({
      detail,
      lifetime,
      environmentName: props.environmentName,
      setTelemetry: input => createDeploymentActions(lifetime, environment.projectSourceId).setTelemetry(environment, input),
      setBindings: input => createDeploymentActions(lifetime, environment.projectSourceId).setBindings(input),
      onSaved: props.onChanged,
    });
  }, [detail, environment, lifetime, props.environmentName, props.onChanged]);
  if (!collectorId) {
    return (
      <EmptyState
        testID="project-deployments.telemetry.off"
        layout="page"
        scene="nothingListening"
        title={t('deploymentTelemetry.empty.title', {
          name: props.environmentName,
        })}
        subtitle={t('deploymentTelemetry.empty.body')}
        {...(canManage && lifetime
          ? {
              primaryAction: {
                label: t('deploymentTelemetry.empty.action'),
                onPress: open,
                testID: 'project-deployments.telemetry.setup',
              },
            }
          : {
              actionUnavailableReason: t('deploymentTelemetry.sheet.noAccess'),
            })}
      />
    );
  }
  return (
    <DeploymentTelemetryTabs
      detail={detail}
      lifetime={lifetime}
      collectorId={collectorId}
      active={props.active ?? true}
      telemetryApplied={props.telemetryApplied}
      onOpenSettings={canManage && lifetime ? open : null}
    />
  );
}

type WindowId = 'hour' | 'day' | 'week';
const WINDOW_MS: Readonly<Record<WindowId, number>> = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const TAB_IDS: readonly TelemetryCaptureList[] = ['endpoints', 'traces', 'logs', 'queries'];
const TAB_LABELS: Readonly<Record<TelemetryCaptureList, () => string>> = {
  endpoints: () => t('deploymentTelemetry.tabs.endpoints'),
  traces: () => t('deploymentTelemetry.tabs.traces'),
  logs: () => t('deploymentTelemetry.tabs.logs'),
  queries: () => t('deploymentTelemetry.tabs.queries'),
};

/** Only presence decides the offline words; an unanswered presence (null) is never offline. */
const selectCollectorOnline = (machine: Machine | null): boolean | null => (machine ? isMachineOnline(machine) : null);

type KeyFlowRoute = Pick<DatabaseCaptureEndpointV1, 'serviceName' | 'method' | 'route'>;

type ListItems =
  | Readonly<{ list: 'endpoints'; items: readonly DatabaseCaptureEndpointV1[]; nextCursor: DatabaseCaptureEndpointCursorV1 | null }>
  | Readonly<{ list: Exclude<TelemetryCaptureList, 'endpoints'>; items: readonly DatabaseCaptureSummaryV1[]; nextCursor: DatabaseCaptureCursorV1 | null }>;

type ListState = Readonly<{
  reads: TelemetryCaptureReads | null;
  key: string;
  data: ListItems | null;
  /** When the shown data was read; the freshness line says it while a later read fails. */
  readAt: number | null;
  reading: boolean;
  failure: string | null;
  loadingMore: boolean;
}>;

/**
 * One page of the open list for the chosen window, read while the tab shows it. Coming back to a list shows what it
 * last read this visit while it reads again; Retry keeps the rows until the answer lands. Show older appends a page.
 */
function useTelemetryCaptureList(reads: TelemetryCaptureReads | null, active: boolean, list: TelemetryCaptureList, windowMs: number, attempt: number) {
  const key = `${list}\u0000${windowMs}`;
  const [state, setState] = React.useState<ListState>({ reads, key, data: null, readAt: null, reading: true, failure: null, loadingMore: false });
  // Last settled answers belong to the current collector, Environment and captured Account lifetime.
  const retained = React.useMemo(() => new Map<string, Readonly<{ data: ListItems; readAt: number }>>(), [reads]);
  const windowRef = React.useRef<Readonly<{ since: number; until: number; signal: AbortSignal }> | null>(null);
  React.useEffect(() => {
    if (!reads || !active) return;
    const controller = new AbortController();
    const until = Date.now();
    const since = Math.max(0, until - windowMs);
    windowRef.current = { since, until, signal: controller.signal };
    const kept = retained.get(key);
    setState(current => current.reads === reads && current.key === key
      ? { ...current, reading: true, loadingMore: false }
      : { reads, key, data: kept?.data ?? null, readAt: kept?.readAt ?? null, reading: true, failure: null, loadingMore: false });
    const read: Promise<ListItems> = list === 'endpoints'
      ? reads.endpoints(since, until, null, controller.signal).then(page => ({ list, ...page }))
      : reads.summaries(list, since, until, null, controller.signal).then(page => ({ list, ...page }));
    read.then(
      data => {
        if (controller.signal.aborted) return;
        retained.set(key, { data, readAt: until });
        setState({ reads, key, data, readAt: until, reading: false, failure: null, loadingMore: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = telemetryCaptureFailureCode(error);
        setState(current => current.reads === reads && current.key === key
          ? { ...current, reading: false, failure }
          : current);
      },
    );
    return () => controller.abort();
  }, [reads, active, list, key, windowMs, attempt, retained]);
  const kept = retained.get(key);
  const shown = state.reads === reads && state.key === key ? state
    : { reads, key, data: kept?.data ?? null, readAt: kept?.readAt ?? null, reading: true, failure: null, loadingMore: false };
  const more = React.useCallback(() => {
    const data = shown.data;
    if (!reads || !active || !data?.nextCursor || shown.reading || shown.loadingMore || !windowRef.current) return;
    const { since, until, signal } = windowRef.current;
    setState(current => ({ ...current, loadingMore: true }));
    const next: Promise<ListItems> = data.list === 'endpoints'
      ? reads.endpoints(since, until, data.nextCursor, signal).then(page => ({ list: 'endpoints' as const,
        items: [...data.items, ...page.items], nextCursor: page.nextCursor }))
      : reads.summaries(data.list, since, until, data.nextCursor, signal).then(page => ({ list: data.list,
        items: [...data.items, ...page.items], nextCursor: page.nextCursor }));
    next.then(
      merged => {
        if (!signal.aborted) setState(current => current.reads === reads && current.key === key ? { ...current, data: merged, loadingMore: false } : current);
      },
      () => {
        if (!signal.aborted) setState(current => current.reads === reads && current.key === key ? { ...current, loadingMore: false } : current);
      },
    );
  }, [reads, active, shown.data, shown.reading, shown.loadingMore, key]);
  const forget = () => {
    retained.clear();
    setState(current => current.reads === reads
      ? { ...current, data: null, readAt: null, failure: null, loadingMore: false }
      : current);
  };
  return { state: shown, more, forget };
}

function DeploymentTelemetryTabs(props: Readonly<{
  detail: DeploymentEnvironmentDetailV1;
  lifetime: ServerAccountScopeLifetime | null;
  collectorId: string;
  active: boolean;
  telemetryApplied: boolean | undefined;
  onOpenSettings: (() => void) | null;
}>) {
  const { detail, lifetime, collectorId, active, telemetryApplied } = props;
  const environment = detail.environment;
  const serverId = lifetime?.scope.serverId ?? null;
  const locale = getPreferredLanguage();
  const collectorLabel = useServerScopedMachineLabel(serverId, collectorId);
  const machine = collectorLabel ?? t('projects.deployments.aMachine');
  const collectorOnline = useServerScopedMachine(serverId, collectorId, selectCollectorOnline);
  const invoke = React.useContext(TelemetryCaptureInvokeContext);
  const reads = React.useMemo(() => lifetime
    ? createTelemetryCaptureReads(invoke, { scope: lifetime.scope, environmentId: environment.id, collectorMachineId: collectorId })
    : null, [invoke, lifetime, environment.id, collectorId]);
  const [tab, setTab] = React.useState<TelemetryCaptureList>('endpoints');
  const [windowId, setWindowId] = React.useState<WindowId>('day');
  const [attempt, setAttempt] = React.useState(0);
  const [collectorStatus, setCollectorStatus] = React.useState<Readonly<{
    reads: TelemetryCaptureReads;
    lastReceivedAt?: number | null;
    failure?: string;
  }> | null>(null);
  React.useEffect(() => {
    if (!active || !reads || telemetryApplied !== true) return;
    const controller = new AbortController();
    reads.status(controller.signal).then(
      status => {
        if (!controller.signal.aborted) setCollectorStatus({ reads, lastReceivedAt: status.lastReceivedAt });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setCollectorStatus({ reads, failure: telemetryCaptureFailureCode(error) });
      },
    );
    return () => controller.abort();
  }, [active, reads, telemetryApplied, attempt]);
  const [openTrace, setOpenTrace] = React.useState<Readonly<{
    reads: TelemetryCaptureReads;
    request: DatabaseCaptureSummaryV1;
  }> | null>(null);
  const openRequest = React.useCallback((request: DatabaseCaptureSummaryV1) => {
    if (reads) setOpenTrace({ reads, request });
  }, [reads]);
  const [addingCheck, setAddingCheck] = React.useState<KeyFlowRoute | null>(null);
  const { state, more, forget } = useTelemetryCaptureList(reads, active, tab, WINDOW_MS[windowId], attempt);
  const retry = React.useCallback(() => setAttempt(value => value + 1), []);
  const clear = reads && environment.capabilities.manage ? async () => {
    try {
      await reads.clear();
    } catch (error) {
      const code = telemetryCaptureFailureCode(error);
      if (lifetime?.isCurrent() && code !== 'approval_canceled' && code !== PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE) {
        alertActionFailure({ code, reason: t('deploymentTelemetry.menu.clearFailed') });
      }
      return;
    }
    if (!lifetime?.isCurrent()) return;
    forget();
    setOpenTrace(current => current?.reads === reads ? null : current);
    retry();
  } : null;
  const offline = collectorOnline === false;
  const readLogBody = React.useCallback((id: string) => active && reads ? reads.logBody(id) : Promise.reject(new Error('telemetry_unavailable')), [active, reads]);

  // Checks are set up by the Environment's managers, in the same editor Settings → Checks and alerts opens.
  const canAddCheck = environment.capabilities.role === 'manager' && lifetime !== null;
  const endpointActions = React.useMemo<readonly CaptureEndpointAction[] | undefined>(() => canAddCheck
    ? [{ id: 'add-check', label: t('deploymentTelemetry.addCheck'), onSelect: setAddingCheck }]
    : undefined, [canAddCheck]);

  const data = state.data;
  const failed = state.failure !== null && !state.reading;
  const status = telemetryApplied && collectorStatus?.reads === reads ? collectorStatus : null;
  const keptOn = t('deploymentTelemetry.recording.keptOn', { machine });
  const collectorLabelText = telemetryApplied === false ? `${keptOn} ${t('deploymentTelemetry.recording.nextDeploy')}`
    : status?.lastReceivedAt === null ? t('deploymentTelemetry.recording.waiting')
    : typeof status?.lastReceivedAt === 'number' ? t('deploymentTelemetry.recording.receiving', {
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(status.lastReceivedAt),
    }) : keptOn;
  const body = failed && data === null ? (
    <SurfaceStateCard
      testID={offline ? 'project-deployments.telemetry.offline' : 'project-deployments.telemetry.unavailable'}
      kind="unavailable"
      title={offline ? t('deploymentTelemetry.offline.title', { machine }) : t('deploymentTelemetry.unavailable.title')}
      reason={offline ? t('deploymentTelemetry.offline.body') : undefined}
      diagnosticCode={offline ? null : state.failure}
      action={{ label: t('common.retry'), onPress: retry, testID: 'project-deployments.telemetry.retry' }}
    />
  ) : tab === 'traces' && openTrace && openTrace.reads === reads ? (
    <TelemetryRequestDetail
      reads={openTrace.reads}
      active={active}
      request={openTrace.request}
      locale={locale}
      onBack={() => setOpenTrace(null)}
      onAddCheck={canAddCheck ? setAddingCheck : undefined}
    />
  ) : data?.list === 'endpoints' ? (
    <CaptureEndpoints items={data.items} loading={state.reading} locale={locale}
      {...(endpointActions ? { actions: endpointActions } : {})}
      more={data.nextCursor ? { onPress: more, busy: state.loadingMore } : null} />
  ) : data?.list === 'traces' ? (
    <CaptureTraces items={data.items} loading={state.reading} locale={locale} onOpen={openRequest}
      more={data.nextCursor ? { onPress: more, busy: state.loadingMore } : null} />
  ) : data?.list === 'logs' ? (
    <CaptureLogs items={data.items} loading={state.reading} locale={locale} readBody={readLogBody}
      more={data.nextCursor ? { onPress: more, busy: state.loadingMore } : null} />
  ) : data?.list === 'queries' ? (
    <CaptureQueries items={data.items} loading={state.reading} locale={locale}
      more={data.nextCursor ? { onPress: more, busy: state.loadingMore } : null} />
  ) : (
    <SurfaceStateCard testID="project-deployments.telemetry.reading" kind="loading" size="line" title={t('common.loading')} />
  );

  return (
    <PageContentColumn testID="project-deployments.telemetry.recording">
    <View style={styles.panel}>
      <View style={styles.lines}>
      {!failed && status?.failure ? (
        <SurfaceStateCard kind="unavailable" size="line" title={t('deploymentTelemetry.unavailable.title')}
          diagnosticCode={status.failure} action={{ label: t('common.retry'), onPress: retry }} />
      ) : null}
      {failed && data !== null ? (
        <SurfaceFreshnessLine
          testID={offline ? 'project-deployments.telemetry.offline' : 'project-deployments.telemetry.stale'}
          tone="warning"
          glyph={offline ? 'wifi-slash' : undefined}
          asOf={state.readAt}
          emphasis={offline ? t('deploymentTelemetry.offline.title', { machine }) : t('deploymentTelemetry.unavailable.title')}
          reason={`${offline ? t('deploymentTelemetry.offline.title', { machine }) : t('deploymentTelemetry.unavailable.title')} · ${
            offline ? t('deploymentTelemetry.offline.reason') : t('deploymentTelemetry.unavailable.reason')}`}
          action={{ label: t('common.retry'), onPress: retry, testID: 'project-deployments.telemetry.retry' }}
        />
      ) : null}
      <View style={styles.bar}>
        <View style={styles.tabs}>
          <SegmentedTabBar<TelemetryCaptureList>
            accessibilityLabel={t('deploymentTelemetry.tabs.label')}
            testIDPrefix="project-deployments.telemetry.tab"
            segmentSizing="content"
            activeTabId={tab}
            tabs={TAB_IDS.map(id => ({ id, label: TAB_LABELS[id]() }))}
            onSelectTab={(id) => { setTab(id); setOpenTrace(null); }}
          />
        </View>
        <View style={styles.barEnd}>
          {/* The tab's state, once, at the bar's trailing edge (lab p7Flows-mark "Receiving · 18:51"). */}
          <Text variant="meta" style={styles.facts} numberOfLines={1} testID="project-deployments.telemetry.collector">
            {collectorLabelText}
          </Text>
          <SegmentedTabBar<WindowId>
            role="radiogroup"
            accessibilityLabel={t('deploymentTelemetry.window.label')}
            testIDPrefix="project-deployments.telemetry.window"
            segmentSizing="content"
            activeTabId={windowId}
            tabs={[{ id: 'hour', label: t('deploymentTelemetry.window.hour') },
              { id: 'day', label: t('deploymentTelemetry.window.day') },
              { id: 'week', label: t('deploymentTelemetry.window.week') }]}
            onSelectTab={(id) => { setWindowId(id); setOpenTrace(null); }}
          />
          {props.onOpenSettings || clear
            ? <TelemetryMenu onOpenSettings={props.onOpenSettings} onClear={clear} /> : null}
        </View>
      </View>
      </View>
      {/* The capture views are the shared public owners; a core page binds them through its Collection scope. */}
      <CoreCollectionScope>{body}</CoreCollectionScope>
      {addingCheck && lifetime ? (
        <AddCheckSetup
          testID="project-deployments.telemetry.add-check"
          onClose={() => setAddingCheck(null)}
          lifetime={lifetime}
          seed={subjectStarterEventSeed('addCheck', {
            subject: { kind: 'environment', environmentId: environment.id, machineId: environment.controllerMachineId },
            // A Key flow is checked on the collector that keeps its requests (J5 "Check from").
            controllerMachineId: collectorId,
            newContributedCheck: {
              kind: TELEMETRY_KEY_FLOW_HEALTH_KIND_V1,
              config: {
                environmentId: environment.id,
                serviceName: addingCheck.serviceName,
                measure: {
                  kind: 'route',
                  routes: [{ method: addingCheck.method, route: addingCheck.route }],
                  statistic: 'p95',
                },
              },
            },
          })}
        />
      ) : null}
    </View>
    </PageContentColumn>
  );
}

function TelemetryMenu({ onOpenSettings, onClear }: Readonly<{
  onOpenSettings: (() => void) | null;
  onClear: (() => Promise<void>) | null;
}>) {
  const [open, setOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const items = [
    ...(onOpenSettings ? [{ id: 'settings', testID: 'project-deployments.telemetry.menu.settings',
      title: t('deploymentTelemetry.menu.settings') }] : []),
    ...(onClear ? [{ id: 'clear', testID: 'project-deployments.telemetry.menu.clear',
      title: t('deploymentTelemetry.menu.clear'), destructive: true, disabled: clearing }] : []),
  ];
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={id => {
        setOpen(false);
        if (id === 'settings') onOpenSettings?.();
        if (id === 'clear' && onClear && !clearing) {
          setClearing(true);
          void onClear().finally(() => setClearing(false));
        }
      }}
      trigger={({ toggle }) => (
        <IconButton testID="project-deployments.telemetry.menu" iconName="dots-three" variant="plain"
          accessibilityLabel={t('common.more')} onPress={toggle} />
      )}
    />
  );
}

type RequestRead =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; trace: CapturedTraceV1 }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

/** A trace row's request (lab p7AddNow-trace): what it was, where its time went, its waterfall and its logs. */
function TelemetryRequestDetail(props: Readonly<{
  reads: TelemetryCaptureReads;
  active: boolean;
  request: DatabaseCaptureSummaryV1;
  locale: string;
  onBack: () => void;
  onAddCheck?: (route: KeyFlowRoute) => void;
}>) {
  const { reads, active, request, locale, onAddCheck } = props;
  const { serviceName, endpointMethod, endpointRoute } = request;
  const traceId = request.traceId ?? null;
  const [read, setRead] = React.useState<RequestRead>({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    if (!traceId) {
      setRead({ kind: 'unavailable', code: 'telemetry_trace_missing' });
      return;
    }
    const controller = new AbortController();
    setRead({ kind: 'loading' });
    reads.trace(traceId, controller.signal).then(
      trace => { if (!controller.signal.aborted) setRead({ kind: 'ready', trace }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setRead({ kind: 'unavailable', code: telemetryCaptureFailureCode(error) });
      },
    );
    return () => controller.abort();
  }, [reads, active, traceId, attempt]);
  const readBody = React.useCallback((id: string) => active ? reads.logBody(id) : Promise.reject(new Error('telemetry_unavailable')), [active, reads]);
  const queries = read.kind === 'ready' ? read.trace.summaries.filter(summary => summary.kind === 'query').length : null;
  const status = request.httpStatusCode === null || request.httpStatusCode === undefined ? null : String(request.httpStatusCode);
  const facts = [
    request.serviceName ?? null,
    status,
    request.durationMs === null || request.durationMs === undefined ? null : formatHappierDuration(request.durationMs, locale),
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(request.at),
  ].filter((part): part is string => part !== null && part.length > 0);
  return (
    <View style={styles.detail} testID="project-deployments.telemetry.request">
      <View style={styles.detailHeader}>
        <TextLinkButton testID="project-deployments.telemetry.request.back" label={t('deploymentTelemetry.request.back')}
          onPress={props.onBack} tone="quiet" size="meta" />
        <Text variant="heading" style={styles.requestTitle} numberOfLines={2}>{requestLabelOf(request)}</Text>
        {onAddCheck && serviceName && endpointMethod && endpointRoute ? (
          <TextLinkButton testID="project-deployments.telemetry.request.add-check" label={t('deploymentTelemetry.addCheck')}
            onPress={() => onAddCheck({ serviceName, method: endpointMethod, route: endpointRoute })} size="meta" />
        ) : null}
        <Text variant="meta" style={styles.facts}>
          {[...facts, ...(queries === null ? [] : [t('deploymentTelemetry.request.queries', { count: queries })])].map((part, index) => (
            <React.Fragment key={index}>
              {index === 0 ? null : ' · '}
              {/* Only the failing status speaks; the rest of the line stays quiet (lab p7AddNow-trace "500"). */}
              {part === status && captureSummaryFailed(request) ? <Text variant="meta" style={styles.failedStatus}>{part}</Text> : part}
            </React.Fragment>
          ))}
        </Text>
      </View>
      {read.kind === 'loading' ? (
        <SurfaceStateCard kind="loading" size="line" title={t('deploymentTelemetry.request.reading')} />
      ) : read.kind === 'unavailable' ? (
        <SurfaceStateCard testID="project-deployments.telemetry.request.unavailable" kind="unavailable" size="line"
          title={t('deploymentTelemetry.request.unavailable')} diagnosticCode={read.code}
          action={{ label: t('common.retry'), onPress: () => setAttempt(value => value + 1) }} />
      ) : (
        <>
          <CapturedRequestSlowest trace={read.trace} locale={locale} />
          <CapturedRequestWaterfall trace={read.trace} locale={locale} title={t('deploymentTelemetry.request.waterfall')} />
          <CapturedRequestLogs trace={read.trace} locale={locale} readBody={readBody} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { gap: theme.space.s16 },
  // The tab's own lines stand on the edge its Collection and the page's sections inset to.
  // Its bar keeps the section gap under the page's own tabs (lab p7Flows-mark).
  lines: { gap: theme.space.s16, paddingTop: theme.space.s16, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  facts: { color: theme.colors.text.secondary },
  failedStatus: { color: theme.colors.state.danger.foreground },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  tabs: { flexShrink: 1, minWidth: 0 },
  barEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  detail: { gap: theme.space.s16 },
  // The detail's header stands on the same edge as the tab bar and its sections.
  detailHeader: { gap: theme.space.s4, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  // The request's identity in identifier type and the theme's ink, legible on either sheet.
  requestTitle: { ...Typography.mono(), color: theme.colors.text.primary },
}));
