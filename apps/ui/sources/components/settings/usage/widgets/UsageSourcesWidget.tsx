import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isUsageSourceMissing, selectUsageSourceDiscoveryInventory, matchesUsageSourceAccountingScope, USAGE_SOURCE_CONSENT_DISCLOSURE, type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import { UsageSourceInventoryScopeSchema, type UsageSourceInventoryScope } from '@happier-dev/protocol/inputs/usageQuery';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    useActiveServerAccountScope,
    useActiveMachineFacts,
    useMachineListStatusForServer,
} from '@/sync/domains/state/storage';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { useReportUsageBodySettled } from './usageBodyHeightMemory';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { t } from '@/text';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { UsageAgentMark, usageAgentTitle } from './usageBodyKit';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import type {
  UsageSourcesController,
  UsageSourcesSnapshot,
} from './usageSourcesController';
import { useUsageSourcesController, type UsageSourcesHookOptions } from './useUsageSources';
import { readUsageSourcesLastKnown } from './usageSourcesController';
import { OutsideBrowsePage, UsageExternalSessionCandidates } from './UsageExternalSessionCandidates';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { useUsageDisclosureCommand } from './usageMountedControls';
import { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/**
 * Sources (lab d2src/usrc): agent usage already on your machines, found by reading metadata only.
 * Each source is consented per machine with the exact server-disclosure copy, then reads in place;
 * Stop keeps counted history and Delete history is its own confirmed operation. Every effect is the
 * machine's `usage.sources.*` Action through the mounted controller; this body holds no capture state.
 */
export function UsageSourcesWidget(
  props: Readonly<{ input: Readonly<Record<string, JsonValue>>; serverId: string; testID: string }>,
): React.ReactElement {
  const viewer = useActiveServerAccountScope();
  const lifetime = React.useMemo(() => {
    const captured = captureActiveServerAccountScopeLifetime();
    return captured?.scope.serverId === props.serverId ? captured : null;
  }, [viewer?.serverId, viewer?.accountId, props.serverId]);
  const machines = useActiveMachineFacts();
  const reachabilityRevision = useMachineReachabilityRevision();
  const nowMs = useMachinePresenceNowMs(machines);
  const presentation = useWidgetPresentation();
  // Online machines first (they can answer now), then by name; offline ones wait quietly.
  const ordered = React.useMemo(() => projectUsageSourcesMachines(machines, nowMs, lifetime?.isCurrent() ? lifetime.scope : null), [machines, nowMs, lifetime, reachabilityRevision]);
  useWidgetFrameBodyCaption(t('usage.board.sources.foundCaption'));
  const inventory = React.useMemo(() => UsageSourceInventoryScopeSchema.safeParse(props.input), [props.input]);
  if (!inventory.success) return <SurfaceStateCard testID={`${props.testID}.invalid`} kind="unavailable"
    layout="inline" size="line" title={t('usage.board.page.queryInvalidTitle')} reason={t('usage.board.page.queryInvalidReason')} />;
  if (!lifetime)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.unavailable`}
        kind="unavailable"
        layout="inline"
        size="line"
        title={t('usage.board.page.signedOutTitle')}
      />
    );
  return (
    <UsageSourcesMachines
      lifetime={lifetime}
      machines={ordered}
      serverId={props.serverId}
      testID={props.testID}
      input={inventory.data}
      compact={presentation !== undefined && presentation.size !== 'large'}
    />
  );
}

/** One machine as Sources reads it: identity, reachability now, and its home for path display. */
export type UsageSourcesMachine = Readonly<{
  id: string;
  name: string;
  online: boolean;
  homeDir?: string;
}>;

/** Sources' inventory projection consumes the canonical presence and display-name owners. */
export function projectUsageSourcesMachines(machines: readonly Pick<Machine, 'id' | 'metadata' | 'active' | 'activeAt' | 'revokedAt' | 'replacedByMachineId' | 'availability'>[], nowMs: number, scope: ServerAccountScope | null): readonly UsageSourcesMachine[] {
  const current = machines.filter(machine => !machine.revokedAt && !isMachineReplaced(machine));
  const names = resolveMachineDisplayNames(current);
  return current.map((machine): UsageSourcesMachine => ({ id: machine.id, online: isMachineSelectableForFleet(scope, machine, nowMs), name: names.get(machine.id)!,
    ...(machine.metadata?.homeDir ? { homeDir: machine.metadata.homeDir } : {}) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The machine list beneath the live owners; the executor is the ordinary default unless supplied. */
export function UsageSourcesMachines(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    machines: readonly UsageSourcesMachine[];
    serverId: string;
    executor?: UsageSourcesHookOptions['executor'];
    testID: string;
    input: UsageSourceInventoryScope;
    compact?: boolean;
  }>,
): React.ReactElement {
  // Source membership comes from metadata discovery, never an Agent or capture-path guess.
  const inventoryStatus = useMachineListStatusForServer(props.serverId);
  const machines = [...new Map(props.machines
    .filter(machine => !props.input.machines.length || props.input.machines.includes(machine.id))
    .map(machine => [machine.id, machine])).values()];
  const online = machines.filter(machine => machine.online);
  const offlineCount = machines.length - online.length;
  const [widthPx, setWidthPx] = React.useState<number | null>(null);
  // Below the row-stack width a source's status moves beneath its folder (phones recompose). Before the body measures
  // itself the frame's width decides, or else the window's (the body is never wider), so a phone draws stacked rows
  // from its first frame instead of wide rows that re-stack 536 px taller one layout later (#6 at 390).
  const frameWidthPx = useWidgetPresentation()?.geometry?.width ?? null;
  const windowWidthPx = useWindowDimensions().width;
  const wide = (widthPx ?? frameWidthPx ?? windowWidthPx) >= HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
  // Only a derived per-machine state leaves each controller (counted content, nothing found, still
  // looking, or unreadable). Inventory, source state and demand stay at the mounted leaf; the grouped
  // lines cannot label a previous Account or selection as current.
  const projectionKey = JSON.stringify([props.input.agents, props.input.sources, online.map(machine => machine.id)]);
  const [stateProjection, setStateProjection] = React.useState<Readonly<{
    lifetime: ServerAccountScopeLifetime; key: string; states: ReadonlyMap<string, UsageSourcesMachineReport>;
  }> | null>(null);
  const retries = React.useRef(new Map<string, (context?: ActionExecutorContext) => void>());
  const reportState = React.useCallback((machineId: string, report: UsageSourcesMachineReport, retry?: (context?: ActionExecutorContext) => void) => {
    if (retry) retries.current.set(machineId, retry); else retries.current.delete(machineId);
    setStateProjection(previous => {
      const current = previous?.lifetime === props.lifetime && previous.key === projectionKey ? previous : null;
      const known = current?.states.get(machineId);
      if (current && known?.state === report.state && known.consentable === report.consentable) return previous;
      const states = new Map(current?.states);
      states.set(machineId, report);
      return { lifetime: props.lifetime, key: projectionKey, states };
    });
  }, [props.lifetime, projectionKey]);
  const states = stateProjection?.lifetime === props.lifetime && stateProjection.key === projectionKey ? stateProjection.states : null;
  const countIn = (state: UsageSourcesMachineState) => online.filter(machine => (states?.get(machine.id)?.state ?? 'looking') === state).length;
  const emptyCount = countIn('none');
  // Every online machine has answered (or failed): the dispatch's cold-load room gives way to the drawn list and
  // remembers its height. A machine inventory still loading is not an empty fleet: settling on it recorded a 104 px
  // room that the next cold load held before growing by the whole list (#6).
  const inventoryLoading = props.machines.length === 0 && inventoryStatus === 'loading';
  useReportUsageBodySettled(!inventoryLoading && (online.length === 0 || states !== null && countIn('looking') === 0));
  const unreadable = online.filter(machine => states?.get(machine.id)?.state === 'unreadable');
  // The server disclosure is said once for the page, beside the sources it governs.
  const consentable = online.some(machine => states?.get(machine.id)?.consentable === true);
  const commands = useCurrentUiContextLocalCommands(!props.compact && unreadable.length ? [{ key: 'retry',
    title: `${t('usage.board.sources.machinesUnreadable')}: ${t('common.retry')}`,
    invoke: (_input, context) => { for (const machine of unreadable) retries.current.get(machine.id)?.(context); } }] : []);
  if (machines.length === 0 && props.machines.length === 0 && inventoryStatus !== 'idle') {
    return inventoryStatus === 'loading'
      ? <ItemLoadStateRows state={{ kind: 'loading' }} testID={`${props.testID}.loading`} />
      : <SurfaceStateCard testID={`${props.testID}.unavailable`} kind="unavailable" layout="inline" size="line"
          title={t('sidebarFooter.availableWhenHomeAnswers')} />;
  }
  if (machines.length === 0)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.empty`}
        kind="empty"
        layout="inline"
        title={t(props.machines.length ? 'usage.board.sources.emptyScopedTitle' : 'usage.board.sources.noMachinesTitle')}
        reason={t(props.machines.length ? 'usage.board.sources.emptyScopedReason' : 'usage.board.sources.noMachinesReason')}
      />
    );
  if (props.compact) return <View testID={`${props.testID}.summary`} style={styles.machines}>
    <Text style={styles.machineName}>{t('projects.identity.machineCount', { count: machines.length })}</Text>
    {offlineCount > 0 ? <Text style={styles.note}>{t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}</Text> : null}
  </View>;
  const groupLine = (testID: string, count: number, status: string) => (
    <Text testID={`${props.testID}.${testID}`} style={styles.note}
      accessibilityLabel={`${t('projects.identity.machineCount', { count })} · ${status}`}>
      {t('projects.identity.machineCount', { count })} · {status}
    </Text>
  );
  // What is counted leads (lab d2src "Happier usage first"): Happier sessions are always live, then
  // every machine's sources. Machines with nothing to show are grouped once below, one status each.
  return (
    <View testID={props.testID} style={styles.machines}
      onLayout={event => { const next = Math.round(event.nativeEvent.layout.width); setWidthPx(previous => previous === next ? previous : next); }}>
      <HappierSessionsSource wide={wide} testID={`${props.testID}.happier`} />
      {/* One Browse request opens every waiting source's outside sessions, as Work's page does, not a link per row. */}
      <OutsideBrowsePage testID={`${props.testID}.browse`}>
        {online.map((machine) => (
          <MachineSources
            key={machine.id}
            machineId={machine.id}
            machineName={machine.name}
            online={machine.online}
            homeDir={machine.homeDir}
            lifetime={props.lifetime}
            serverId={props.serverId}
            executor={props.executor}
            agentIds={props.input.agents}
            accountingSources={props.input.sources}
            onState={reportState}
            wide={wide}
            testID={`${props.testID}.machine.${machine.id}`}
          />
        ))}
      </OutsideBrowsePage>
      {unreadable.length + emptyCount + offlineCount > 0 ? <View style={styles.groups}>
        {unreadable.length > 0 ? (
          <SurfaceFreshnessLine
            testID={`${props.testID}.unreadableMachines`}
            tone="warning"
            reason={`${t('projects.identity.machineCount', { count: unreadable.length })} · ${t('usage.board.sources.machinesUnreadable')}`}
            action={{ label: t('common.retry'), onPress: () => { void commands.invoke('retry'); } }}
          />
        ) : null}
        {emptyCount > 0 ? groupLine('emptyMachines', emptyCount, t('usage.board.sources.machineNone')) : null}
        {offlineCount > 0 ? <Text testID={`${props.testID}.offline`} style={styles.note}
          accessibilityLabel={t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}>
          {t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}
        </Text> : null}
      </View> : null}
      {consentable ? <ConsentDisclosure testID={`${props.testID}.disclosure`} /> : null}
    </View>
  );
}

/** How a mounted machine reads in the grouped lines: its sources, or the one status it shares with others. */
type UsageSourcesMachineState = 'content' | 'none' | 'looking' | 'unreadable';
type UsageSourcesMachineReport = Readonly<{ state: UsageSourcesMachineState; consentable: boolean }>;

/** The one status a source shows, decided once: what it is, what to say, and how loudly. */
export type UsageSourceRowStatus = Readonly<{
  kind: 'found' | 'missing' | 'reading' | 'counted' | 'stopped' | 'failed' | 'unsupported';
  label: string;
  tone: 'ok' | 'active' | 'quiet' | 'warning';
}>;

/**
 * One status per source from the Machine's source record. A source whose folder was never found and
 * that holds no counted history is `missing` (grouped quietly per machine); a source that cannot be
 * read says only that, never also "not readable yet" or an offer to resume.
 */
export function resolveUsageSourceRowStatus(source: Pick<UsageSourceV1, 'consent' | 'status' | 'coverage' | 'root' | 'pendingCount' | 'asOfMs'>): UsageSourceRowStatus {
  if (source.consent === 'disabled' && source.status === 'found') return { kind: 'found', label: '', tone: 'quiet' };
  if (isUsageSourceMissing(source)) return { kind: 'missing', label: '', tone: 'quiet' };
  if (source.status === 'reading') return { kind: 'reading', tone: 'active', label: source.pendingCount > 0
    ? t('usage.board.sources.reading', { count: source.pendingCount }) : t('usage.board.sources.readingStarted') };
  if (source.status === 'error' || source.status === 'unavailable') return { kind: 'failed', tone: 'warning',
    label: t(source.status === 'error' ? 'usage.board.sources.failed' : 'usage.board.sources.unavailable') };
  if (source.status === 'unsupported' || source.coverage === 'unsupported')
    return { kind: 'unsupported', tone: 'quiet', label: t('usage.board.sources.unsupported') };
  if (source.status === 'stopped' || source.consent === 'disabled') return { kind: 'stopped', tone: 'quiet', label: t('usage.board.sources.stopped') };
  return { kind: 'counted', tone: 'ok', label: source.coverage === 'partial' ? t('usage.board.sources.countedPartial')
    : source.asOfMs !== null ? t('usage.board.sources.countedAsOf', { time: formatUsageObservedAt(source.asOfMs) })
      : t('usage.board.sources.counted') };
}

/** Happier's own sessions are counted as they run on every machine: the first counted source, always live. */
function HappierSessionsSource(props: Readonly<{ wide: boolean; testID: string }>) {
  const { theme } = useUnistyles();
  const status = (
    <View style={[styles.stateLine, props.wide && styles.stateColumn]}>
      <Text style={styles.stateText} numberOfLines={1}>{t('usage.board.sources.happierLive')}</Text>
    </View>
  );
  return (
    <View testID={props.testID} style={[styles.source, styles.happier]}>
      <View style={styles.sourceMark}>
        <Icon name="chats-circle" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      </View>
      <View style={styles.sourceBody}>
        <Text style={styles.sourceTitle} numberOfLines={1}>{t('usage.board.sources.happierTitle')}</Text>
        <Text style={styles.sourceSubtitle} numberOfLines={1}>{t('usage.board.sources.happierSubtitle')}</Text>
        {props.wide ? null : status}
      </View>
      {props.wide ? status : null}
    </View>
  );
}

function ConsentDisclosure(props: Readonly<{ testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={styles.disclosure}>
      <Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
      <Text style={[styles.note, styles.disclosureText]}>{USAGE_SOURCE_CONSENT_DISCLOSURE}</Text>
    </View>
  );
}

const MachineSources = React.memo(function MachineSources(
  props: Readonly<{
    machineId: string;
    machineName: string;
    online: boolean;
    homeDir?: string;
    lifetime: ServerAccountScopeLifetime;
    executor?: UsageSourcesHookOptions['executor'];
    serverId: string;
    testID: string;
    agentIds: readonly string[];
    accountingSources: readonly string[];
    wide: boolean;
    onState(machineId: string, report: UsageSourcesMachineReport, retry?: (context?: ActionExecutorContext) => void): void;
  }>,
) {
  const { theme } = useUnistyles();
  const tracker = useOptionalPluginUiScrollActivityTracker();
  const shellRef = React.useRef<View | null>(null);
  const placement = useMeasuredNearViewport(tracker, shellRef, true, props.machineId);
  const { measure } = placement;
  // Until its place is measured a machine draws its rows: hiding them first drew a body short by every found row, which
  // grew once the page measured it (#6: +536 px on a warm revisit at 390). A far machine then holds its drawn height.
  const near = placement.near || !placement.measured;
  const [bodyHeight, setBodyHeight] = React.useState(0);
  const { controller, snapshot, ready } = useUsageSourcesController({
    machineId: props.machineId,
    lifetime: props.lifetime,
    ...(props.executor ? { executor: props.executor } : {}),
  });
  // Mounting is visible demand (the area only mounts bodies near the viewport): read metadata once.
  React.useEffect(() => {
    if (controller && props.online && ready) void controller.discover();
  }, [controller, props.online, ready]);
  const scoped = selectUsageSourceDiscoveryInventory(snapshot.sources).filter(source => matchesUsageSourceAccountingScope(source, props.accountingSources)
    && (!props.agentIds.length || props.agentIds.some(agentId =>
    agentId === buildQualifiedPluginContributionKey(source.agent)
      || agentId === resolveBundledAgentIdFromContributionIdentity(source.agent))));
  const rows = scoped
    .filter(source => !(source.consent === 'disabled' && source.status === 'found' && snapshot.dismissedSourceIds.includes(source.sourceId)))
    .map(source => ({ source, status: resolveUsageSourceRowStatus(source) }));
  const tracked = rows.filter(row => row.status.kind !== 'found' && row.status.kind !== 'missing');
  const found = rows.filter(row => row.status.kind === 'found');
  // One Agent's folders sit together (what is counted first), so a name never repeats across separate status groups.
  const listed = [...tracked, ...found].map(row => ({ ...row, agent: usageAgentTitle(usageSourceAgentKey(row.source)) }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
  const missing = rows.filter(row => row.status.kind === 'missing').map(row => row.source);
  const counted = scoped.filter(source => source.consent === 'enabled').length;
  const discovering = snapshot.pending.some(operation => operation.actionId === 'usage.sources.discover');
  // One status per machine: an unreadable machine is never also "looking", and a machine with
  // nothing to show joins its group's single line instead of drawing a header of its own.
  const state: UsageSourcesMachineState = snapshot.approval || (snapshot.loaded && scoped.length > 0) ? 'content'
    : snapshot.error && !snapshot.loaded ? 'unreadable'
      : snapshot.loaded ? 'none' : 'looking';
  // Consent is asked where a source can be added or resumed (or is counted and can be stopped).
  const consentable = state === 'content' && [...tracked, ...found].some(row => row.status.kind !== 'unsupported' && row.status.kind !== 'failed'
    || row.source.consent === 'enabled');
  const retry = React.useCallback((context?: ActionExecutorContext) => { void controller?.discover(context); }, [controller]);
  React.useEffect(() => { props.onState(props.machineId, { state, consentable }, state === 'unreadable' ? retry : undefined); },
    [props.onState, props.machineId, state, consentable, retry]);
  React.useEffect(() => { if (state === 'content') measure(); }, [state, measure]);
  // A machine still being read holds a section's room (its header and the shared loading rows), so the page does not
  // move when its sources arrive (R138); a machine with nothing to show later joins its group's single line.
  if (state === 'looking') return (
    <View testID={`${props.testID}.looking`} style={[styles.machine, styles.machineDivided]}>
      <View style={styles.machineHeader}>
        <Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
        <Text style={styles.machineName} numberOfLines={1}>{props.machineName}</Text>
        <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
      </View>
      {/* A revisit's controller opens on the last-known sources a frame later; until then the rows hold their count. */}
      <ItemLoadStateRows state={{ kind: 'loading' }} rows={readUsageSourcesLastKnown(props.lifetime, props.machineId)?.length || 3} lines={2}
        accessibilityLabel={`${props.machineName} · ${t('usage.board.sources.machineLooking')}`} />
    </View>
  );
  if (state !== 'content') return null;
  const rowProps = (source: UsageSourceV1) => ({
    source, snapshot, machineName: props.machineName, lifetime: props.lifetime, online: props.online,
    homeDir: props.homeDir, serverId: props.serverId, testID: `${props.testID}.source.${source.sourceId}`,
  });
  return (
    <View ref={shellRef} testID={props.testID} style={[styles.machine, styles.machineDivided]} onLayout={measure}>
      <View style={styles.machineHeader}>
        <Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
        <Text style={styles.machineName} numberOfLines={1}>{props.machineName}</Text>
        {counted > 0 ? (
          <Text style={styles.machineStatus} numberOfLines={1}>{t('usage.board.sources.machineCounted', { count: counted })}</Text>
        ) : null}
        {discovering ? <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.tertiary} /> : null}
      </View>
      {/* A failed re-read is the machine's, said once here; each source below keeps its own last-known status (R140). */}
      {snapshot.machineReadFailed ? (
        <SurfaceFreshnessLine testID={`${props.testID}.readFailed`} tone="warning" reason={t('usage.board.sources.machineReadFailed')}
          action={{ label: t('common.retry'), onPress: () => retry(), testID: `${props.testID}.readFailed.retry` }} />
      ) : null}
      {snapshot.approval || (controller && listed.length + missing.length > 0) ? <View style={styles.machineBody}
        onLayout={event => { if (near) { const height = event.nativeEvent.layout.height; setBodyHeight(previous => previous === height ? previous : height); } }}>
      {!near ? <View style={{ height: bodyHeight }} /> : null}
      {near && snapshot.approval ? <Text style={styles.note}>{t('usage.board.sources.approvalPending')}</Text> : null}
      {controller ? listed.map(row => row.status.kind === 'found' ? (
        near ? <FoundSourceRow key={row.source.sourceId} {...rowProps(row.source)} controller={controller} /> : null
      ) : (
        <TrackedSourceRow key={row.source.sourceId} {...rowProps(row.source)} status={row.status} controller={controller} wide={props.wide} visible={near} />
      )) : null}
      {controller && missing.length > 0 ? (
        <MissingSources sources={missing} controller={controller} machineName={props.machineName} serverId={props.serverId}
          busy={snapshot.pending} testID={`${props.testID}.missing`} visible={near} />
      ) : null}
      </View> : null}
    </View>
  );
});

const usageSourceAgentKey = (source: UsageSourceV1) =>
  resolveBundledAgentIdFromContributionIdentity(source.agent) ?? buildQualifiedPluginContributionKey(source.agent);

type SourceRowProps = Readonly<{
  source: UsageSourceV1;
  snapshot: UsageSourcesSnapshot;
  controller: UsageSourcesController;
  machineName: string;
  lifetime: ServerAccountScopeLifetime;
  online: boolean;
  homeDir?: string;
  serverId: string;
  testID: string;
}>;

/** Shared identity and effects of one source row: its name, folder and the Actions behind its controls. */
function useSourceRow(props: SourceRowProps, visible = true) {
  const { source, controller } = props;
  const agentId = usageSourceAgentKey(source);
  const agent = usageAgentTitle(agentId);
  const busy = props.snapshot.pending.some(operation => operation.sourceId === source.sourceId && operation.actionId !== 'usage.sources.get');
  const folder = source.root.path ? formatPathRelativeToHome(source.root.path, props.homeDir) : t('usage.board.sources.defaultFolder');
  const Bridge = useCurrentUiContextCommandBridge();
  const changeFolder = React.useCallback(async (context: ActionExecutorContext) => {
    let confirmedContext: ActionExecutorContext | undefined;
    const next = await Modal.prompt(
      t('usage.board.sources.folderPromptTitle'),
      t('usage.board.sources.folderPromptMessage', { agent, machine: props.machineName }),
      { defaultValue: source.root.path ?? '', placeholder: source.root.path ?? '~', commandBridge: Bridge,
        onConfirmContext: confirming => { confirmedContext = confirming; } },
    );
    // The Machine expands and validates the path with its own home-directory owner.
    if (next !== null && next.trim().length > 0 && next.trim() !== source.root.path) await controller.setRoot(source.sourceId, next.trim(), confirmedContext ?? context);
  }, [controller, source.sourceId, source.root.path, agent, props.machineName, Bridge]);
  const commands = useCurrentUiContextLocalCommands(visible && !busy ? [{ key: 'change-folder',
    title: t('usage.board.sources.changeFolder'), description: `${props.testID}.folder`,
    invoke: (_input, context) => changeFolder(context) }] : []);
  return { agentId, agent, busy, folder, changeFolder: async () => { await commands.invoke('change-folder'); } };
}

function SourceIdentity(props: Readonly<{ agentId: string; agent: string; folder: string; serverId: string; children?: React.ReactNode }>) {
  return (
    <>
      <View style={styles.sourceMark}><UsageAgentMark agentId={props.agentId} serverId={props.serverId} /></View>
      <View style={styles.sourceBody}>
        <Text style={styles.sourceTitle} numberOfLines={1}>{props.agent}</Text>
        {/* Same-name folders differ at their end ("…-acct-a", "…-acct-b"): the path gives up its middle. */}
        <MiddleEllipsisText style={styles.sourceSubtitle} value={props.folder} />
        {props.children}
      </View>
    </>
  );
}

/** A source the machine reads or has read: one status, the Counted switch (consent) and its options menu. */
function TrackedSourceRow(props: SourceRowProps & Readonly<{ status: UsageSourceRowStatus; wide: boolean; visible: boolean }>) {
  const { theme } = useUnistyles();
  const { source, controller, status } = props;
  const { agentId, agent, busy, folder, changeFolder } = useSourceRow(props, props.visible);
  const deletion = props.snapshot.historyDeletion?.sourceId === source.sourceId ? props.snapshot.historyDeletion : null;
  const enabled = source.consent === 'enabled';
  const retained = enabled || source.status === 'stopped' || source.pendingCount > 0 || source.asOfMs !== null;
  // Counting can be switched off whenever it is on; it can be switched on only where the source is readable.
  const switchable = enabled || status.kind === 'stopped';
  const actions: ItemAction[] = [
    ...folderActions(props.testID, source, controller, busy, changeFolder),
    ...(retained ? [{ id: `${props.testID}.delete`, title: t('usage.board.sources.deleteHistory'), icon: 'trash' as const, destructive: true,
      disabled: busy, onPress: () => { void controller.deleteHistory(source.sourceId); } }] : []),
  ];
  const stateLine = status.kind === 'failed' ? (
    <SurfaceFreshnessLine testID={`${props.testID}.failed`} tone="warning" asOf={source.asOfMs} reason={status.label}
      action={{ label: t('common.retry'), onPress: () => controller.refresh(source.sourceId) }} />
  ) : (
    <View style={[styles.stateLine, props.wide && styles.stateColumn]}>
      {status.kind === 'reading' ? <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.link} /> : null}
      <Text style={styles.stateText} numberOfLines={2}>{status.label}</Text>
    </View>
  );
  const inlineState = props.wide && status.kind !== 'failed';
  const renderRow = (outside: React.ReactNode) => props.visible ? (
    <View testID={props.testID} style={styles.source} accessibilityState={{ busy }}>
      <SourceIdentity agentId={agentId} agent={agent} folder={folder} serverId={props.serverId}>
        {inlineState ? null : stateLine}
        {deletion ? <Text style={styles.note}>{t('usage.board.sources.deleted', { count: deletion.deletedEventCount })}</Text> : null}
        {outside}
      </SourceIdentity>
      {inlineState ? stateLine : null}
      <View style={styles.controls}>
        <Switch testID={`${props.testID}.counted`} value={enabled} disabled={busy || !switchable}
          accessibilityLabel={t('usage.board.sources.countedToggle', { agent })}
          onValueChange={next => { void (next ? controller.setConsent(source.sourceId, true) : controller.stop(source.sourceId)); }} />
        <SourceOptions testID={props.testID} agent={agent} actions={actions} />
      </View>
    </View>
  ) : null;
  return source.externalSessionSource ? <UsageExternalSessionCandidates source={source} lifetime={props.lifetime}
    online={props.online} testID={`${props.testID}.outside`} visible={props.visible}>{renderRow}</UsageExternalSessionCandidates> : renderRow(null);
}

/** A source found on the machine and not counted yet: what it is, where it is, Add; Not now waits in its menu. */
function FoundSourceRow(props: SourceRowProps) {
  const { source, controller } = props;
  const { agentId, agent, busy, folder, changeFolder } = useSourceRow(props);
  const actions: ItemAction[] = [
    ...folderActions(props.testID, source, controller, busy, changeFolder),
    { id: `${props.testID}.notNow`, title: t('usage.board.sources.notNow'), icon: 'eye-slash', disabled: busy,
      onPress: () => { void controller.notNow(source.sourceId); } },
  ];
  return (
    <View testID={props.testID} style={styles.source} accessibilityState={{ busy }}>
      <SourceIdentity agentId={agentId} agent={agent} folder={folder} serverId={props.serverId} />
      <View style={styles.controls}>
        <RoundButton size="small" display="secondary" title={t('usage.board.sources.add')} loading={busy}
          onPress={() => { void controller.setConsent(source.sourceId, true); }} testID={`${props.testID}.add`} />
        <SourceOptions testID={props.testID} agent={agent} actions={actions} />
      </View>
    </View>
  );
}

/** Folder choices every source row offers behind its options menu. */
function folderActions(testID: string, source: UsageSourceV1, controller: UsageSourcesController, busy: boolean,
  changeFolder: () => Promise<void>): ItemAction[] {
  return [
    { id: `${testID}.folder`, title: t('usage.board.sources.changeFolder'), icon: 'folder', disabled: busy, onPress: () => { void changeFolder(); } },
    ...(source.root.kind === 'override' ? [{ id: `${testID}.defaultFolder`, title: t('usage.board.sources.useDefaultFolder'), icon: 'folder-open' as const,
      disabled: busy, onPress: () => { void controller.setRoot(source.sourceId, null); } }] : []),
  ];
}

function SourceOptions(props: Readonly<{ testID: string; agent: string; actions: ItemAction[] }>) {
  const label = t('usage.board.sources.sourceOptions', { agent: props.agent });
  const [open, setOpen] = React.useState(false);
  const toggle = useUsageDisclosureCommand(label, open, () => setOpen(value => !value));
  return <ItemRowActions title={label} actions={props.actions} overflowOnly
    overflowOpen={open} onOverflowOpenChange={next => { if (next !== open) toggle(); }}
    overflowTriggerTestID={`${props.testID}.options`} overflowTriggerAccessibilityLabel={label} />;
}

/** Agents whose folder was not found on this machine: one quiet line, with a folder choice per Agent on demand. */
function MissingSources(props: Readonly<{
  sources: readonly UsageSourceV1[];
  controller: UsageSourcesController;
  machineName: string;
  serverId: string;
  busy: UsageSourcesSnapshot['pending'];
  testID: string;
  visible: boolean;
}>) {
  const [open, setOpen] = React.useState(false);
  const toggle = useUsageDisclosureCommand(t('usage.board.sources.chooseFolders'), open, () => setOpen(value => !value), props.visible);
  if (!props.visible) return null;
  const agents = [...new Set(props.sources.map(source => usageAgentTitle(usageSourceAgentKey(source))))];
  const line = t('usage.board.sources.notFoundAgents', { agents: agents.join(', ') });
  return (
    <View testID={props.testID} style={styles.missing}>
      <View style={styles.missingLine}>
        <Text style={[styles.note, styles.missingText]} accessibilityLabel={line}>{line}</Text>
        <RoundButton size="small" display="inverted" title={t(open ? 'common.done' : 'usage.board.sources.chooseFolders')}
          onPress={toggle} testID={`${props.testID}.toggle`} />
      </View>
      {open ? props.sources.map(source => (
        <MissingSourceRow key={source.sourceId} source={source} controller={props.controller} machineName={props.machineName}
          serverId={props.serverId} busy={props.busy.some(operation => operation.sourceId === source.sourceId)}
          testID={`${props.testID}.${source.sourceId}`} />
      )) : null}
    </View>
  );
}

function MissingSourceRow(props: Readonly<{ source: UsageSourceV1; controller: UsageSourcesController; machineName: string;
  serverId: string; busy: boolean; testID: string }>) {
  const agentId = usageSourceAgentKey(props.source);
  const agent = usageAgentTitle(agentId);
  const Bridge = useCurrentUiContextCommandBridge();
  const choose = async (context: ActionExecutorContext) => {
    let confirmedContext: ActionExecutorContext | undefined;
    const next = await Modal.prompt(t('usage.board.sources.folderPromptTitle'),
      t('usage.board.sources.folderPromptMessage', { agent, machine: props.machineName }),
      { defaultValue: '', placeholder: '~', commandBridge: Bridge,
        onConfirmContext: confirming => { confirmedContext = confirming; } });
    if (next !== null && next.trim().length > 0) await props.controller.setRoot(props.source.sourceId, next.trim(), confirmedContext ?? context);
  };
  const commands = useCurrentUiContextLocalCommands(!props.busy ? [{ key: 'choose-folder',
    title: t('usage.board.sources.changeFolder'), description: `${props.testID}.folder`,
    invoke: (_input, context) => choose(context) }] : []);
  return (
    <View testID={props.testID} style={styles.missingRow}>
      <UsageAgentMark agentId={agentId} serverId={props.serverId} />
      <Text style={[styles.sourceSubtitle, styles.missingText]} numberOfLines={1}>{agent}</Text>
      <RoundButton size="small" display="inverted" title={t('usage.board.sources.changeFolder')} disabled={props.busy}
        onPress={() => { void commands.invoke('choose-folder'); }} testID={`${props.testID}.folder`} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  machines: {
    gap: theme.space.s4,
  },
  happier: {
    paddingVertical: theme.space.s12,
  },
  groups: {
    gap: theme.space.s4,
    paddingTop: theme.space.s8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  machine: {
    gap: theme.space.s12,
    paddingVertical: theme.space.s12,
  },
  machineDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  machineBody: {
    gap: theme.space.s12,
  },
  machineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  machineName: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  machineStatus: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  source: {
    flexDirection: 'row',
    gap: theme.space.s12,
    alignItems: 'flex-start',
    paddingLeft: theme.space.s4,
  },
  // Wide rows read as the lab's table: identity, one status column, then Counted and its menu.
  stateColumn: {
    flex: 1,
    marginTop: 0,
    alignSelf: 'center',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    alignSelf: 'center',
  },
  missing: {
    gap: theme.space.s8,
    paddingLeft: theme.space.s4,
  },
  missingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  missingText: {
    flex: 1,
    minWidth: 0,
  },
  missingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingTop: theme.space.s8,
  },
  disclosureText: {
    flex: 1,
    minWidth: 0,
  },
  sourceMark: {
    paddingTop: theme.space.s2,
  },
  sourceBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  sourceTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  sourceSubtitle: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  stateLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    marginTop: theme.space.s6,
  },
  stateText: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  note: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s10,
  },
}));
