import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';
import {
  Status,
  useHappierCollection,
  type CollectionAnatomy,
} from '@happier-dev/plugin-ui';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { RowMark } from '@/components/store/inventory/ManagedInventoryDirectory';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';

import { buildServiceCheckHref } from './deploymentNavigation';
import {
  SERVICES_ONE_SHEET,
  ServicesPageList,
} from './DeploymentEnvironmentRows';
import { ServiceCheckBars, type ServiceCheckBarCell } from './ServiceCheckBars';
import { ServiceCheckDetail } from './ServiceCheckDetail';
import {
  NO_OFFLINE_OBSERVERS,
  SERVICE_CHECK_ROW_BARS,
  formatServiceCheckLatency,
  serviceCheckListFacts,
  serviceCheckMonitorSummary,
  serviceCheckStale,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  serviceCheckUptimeText,
  type ServiceCheckListFacts,
} from './serviceCheckPresentation';

const k = 'projects.deployments.services' as const;
const m = 'projects.deployments.monitoring' as const;

const formatClock = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), { hour: 'numeric', minute: '2-digit' });
/** A moment as a clock when it is today, else with its day ("Nov 14, 12:25"), so an old time never reads as today's. */
const formatMoment = (ms: number) =>
  new Date(ms).toDateString() === new Date().toDateString() ? formatClock(ms)
    : formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export type ServiceCheckSelection = Readonly<{
  selectedKey: string | null;
  onSelect: (row: ManagedConfiguredCheckRow) => void;
  /** The selected Check's current row (its results move on), for the details pane the page hosts. */
  onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void;
}>;

/**
 * Where a Check opens (Services and Monitoring): beside the page where a details pane fits (one body for pane and
 * page), otherwise as its own page, which is also the pane's Open as page. `active` says whether the page's checks are
 * the ones on screen, so a pane never shows a Check the page no longer lists.
 */
export function useServiceCheckSelection(active: boolean) {
  const router = useRouter();
  const besidePage = useDetailsPaneAvailable();
  const [checkKey, setCheckKey] = React.useState<string | null>(null);
  const [checkRow, setCheckRow] =
    React.useState<ManagedConfiguredCheckRow | null>(null);
  const openCheckPage = React.useCallback(
    (row: ManagedConfiguredCheckRow) => {
      router.push(
        buildServiceCheckHref({
          automationId: row.automationId,
          triggerId: row.triggerId,
        }) as never,
      );
    },
    [router],
  );
  const selectCheck = React.useCallback(
    (row: ManagedConfiguredCheckRow) => {
      if (besidePage) setCheckKey(row.key);
      else openCheckPage(row);
    },
    [besidePage, openCheckPage],
  );
  const closeCheck = React.useCallback(() => setCheckKey(null), []);
  const selection = React.useMemo<ServiceCheckSelection>(
    () => ({
      selectedKey: checkKey,
      onSelect: selectCheck,
      onSelectedRow: setCheckRow,
    }),
    [checkKey, selectCheck],
  );
  const shown =
    active && checkKey !== null && checkRow !== null && besidePage
      ? checkRow
      : null;
  const details = React.useMemo(
    () =>
      shown
        ? {
            header: {
              title: serviceCheckListFacts(shown).title,
              actions: (
                <CorePluginUiPresentationScope>
                  <DetailsPaneOpenAsPageButton
                    testID="services.checks.detailPane.openAsPage"
                    accessibilityLabel={t('capabilities.store.openAsPage')}
                    onPress={() => openCheckPage(shown)}
                  />
                </CorePluginUiPresentationScope>
              ),
            },
            content: (
              <ItemList testID="services.checks.detail">
                <ServiceCheckDetail row={shown} />
              </ItemList>
            ),
          }
        : null,
    [openCheckPage, shown],
  );
  return { selection, details, closeCheck };
}

/**
 * The observing Machines this Home cannot reach, by the Machine presence owner (the Machines list's own verdict, pushed
 * on every heartbeat): the one input of serviceCheckStale for the rows, the glance line and Needs you.
 */
export function useServiceCheckOfflineObservers(
  rows: readonly ManagedConfiguredCheckRow[],
  scope: ServerAccountScope | null,
): ReadonlySet<string> {
  const machineIds = React.useMemo(
    () => [...new Set(rows.flatMap((row) =>
      row.native.enabled && row.definitionFacts.kind === 'available' && row.definitionFacts.observerMachineId !== null
        ? [row.definitionFacts.observerMachineId] : []))].sort(),
    [rows],
  );
  const summaries = useMachinePresenceSummaries(scope?.serverId ?? null, machineIds);
  return React.useMemo(() => {
    if (machineIds.length === 0) return NO_OFFLINE_OBSERVERS;
    const offline = machineIds.filter((_, index) => {
      const summary = summaries[index];
      return summary?.machineIsKnown === true && describeMachinePresenceSummary(summary).status === 'offline';
    });
    return offline.length === 0 ? NO_OFFLINE_OBSERVERS : new Set(offline);
  }, [machineIds, summaries]);
}

type RowInput = Readonly<{
  scope: ServerAccountScope | null;
  machine: null;
  projectKey: null;
}>;
const keyOfCheck = (row: ManagedConfiguredCheckRow) => row.key;

/**
 * The Checks collection (lab svcChk with MONITOR-LAB-1115 A1/B1): one row per saved Check, named by what it checks,
 * with its last 30 checks as bars, its response, its 30-day uptime and its state when it speaks; healthy says nothing.
 * Services → Checks lists them; Monitoring groups the ones that need the person first (`grouping="attention"`) and can
 * show them as cards. Every fact comes from the Check presentation owner.
 */
export function ServiceCheckList(
  props: Readonly<{
    rows: readonly ManagedConfiguredCheckRow[];
    scope: ServerAccountScope | null;
    selection: ServiceCheckSelection;
    testID: string;
    accessibilityLabel: string;
    grouping?: 'attention';
    presentation?: 'list' | 'grid';
  }>,
) {
  const { rows, selection } = props;
  const { onSelect, onSelectedRow } = selection;
  const input = React.useMemo<RowInput>(
    () => ({ scope: props.scope, machine: null, projectKey: null }),
    [props.scope],
  );
  const offlineObservers = useServiceCheckOfflineObservers(rows, props.scope);
  // Results arrive for every check in one read: until they do, each row reserves its title and bars (lab B5 loading),
  // and no section is decided, so nothing is renamed or moved when they land.
  const settling = rows.some((row) => row.lastResults.kind === 'loading');
  const facts = React.useMemo(
    () => new Map(rows.map((row) => [row.key, serviceCheckListFacts(row)])),
    [rows],
  );
  const selected = selection.selectedKey
    ? (rows.find((candidate) => candidate.key === selection.selectedKey) ??
      null)
    : null;
  React.useEffect(() => {
    onSelectedRow(selected);
  }, [onSelectedRow, selected]);
  const open = React.useCallback(
    (key: string | number | null) => {
      const row =
        key === null
          ? undefined
          : rows.find((candidate) => candidate.key === String(key));
      if (row) onSelect(row);
    },
    [onSelect, rows],
  );
  // What needs the person, decided once results are in: Monitoring stands it in its own section; a list without
  // sections (Services → Checks, lab A1) leads with it.
  const attention = React.useMemo(
    () => (settling ? null : serviceCheckMonitorSummary(rows, offlineObservers).needsYou),
    [rows, settling, offlineObservers],
  );
  const needsYou = props.grouping === 'attention' ? attention : null;
  const items = React.useMemo(
    () =>
      props.grouping === 'attention' || !attention || attention.size === 0
        ? rows
        : [...rows.filter((row) => attention.has(row.key)), ...rows.filter((row) => !attention.has(row.key))],
    [attention, props.grouping, rows],
  );
  const groups = React.useMemo(
    () =>
      needsYou
        ? {
            axis: [
              {
                key: 'needsYou',
                title: t(`${m}.needsYou`),
                section: SERVICES_ONE_SHEET,
              },
              {
                key: 'checks',
                title: t(`${m}.checks`),
                section: SERVICES_ONE_SHEET,
              },
            ],
            groupOf: (row: ManagedConfiguredCheckRow) =>
              needsYou.has(row.key) ? 'needsYou' : 'checks',
          }
        : undefined,
    [needsYou],
  );
  const model = useHappierCollection<ManagedConfiguredCheckRow>({
    items,
    keyOf: keyOfCheck,
    ...(groups ? { groups } : {}),
    openKey: selection.selectedKey,
    onOpenChange: open,
  });
  const scope = props.scope;
  const anatomy = React.useMemo<
    CollectionAnatomy<ManagedConfiguredCheckRow>
  >(() => {
    const factsOf = (row: ManagedConfiguredCheckRow) => facts.get(row.key)!;
    const staleOf = (row: ManagedConfiguredCheckRow) => serviceCheckStale(row, offlineObservers);
    const state = (row: ManagedConfiguredCheckRow) =>
      settling ? null : <CheckState row={row} facts={factsOf(row)} stale={staleOf(row)} />;
    const bars = (row: ManagedConfiguredCheckRow) => (
      <CheckRowBars facts={factsOf(row)} stale={staleOf(row)} loading={settling} />
    );
    return {
      glyph: (row) => (
        <RowMark row={row} title={row.native.name} input={input} />
      ),
      title: (row) => factsOf(row).title,
      // A host or path: one line, ending in an ellipsis, never broken mid-word (the full title is the row's label).
      titleIdentifier: true,
      // Its target arrives with its definition: until then the title's place holds the loading bar, never the saved
      // automation's name it would then flip from.
      titlePending: (row) => settling || row.definitionFacts.kind === 'loading',
      // Line 2 says what the check is, or why it fails when it does; a phone (no columns) also draws its bars there.
      byline: (row, layout) => (
        <CheckByline
          row={row}
          facts={factsOf(row)}
          scope={scope}
          stale={staleOf(row)}
          loading={settling}
          columns={layout?.fieldColumns === true}
        />
      ),
      bylineLead: (row, layout) =>
        layout?.fieldColumns !== true && checkStateSpeaks(row, factsOf(row), staleOf(row))
          ? state(row)
          : null,
      fields: [
        {
          key: 'recent',
          title: t(`${m}.columnRecent`, { count: SERVICE_CHECK_ROW_BARS }),
          minWidth: 172,
          priority: 3,
          listColumn: true,
          render: bars,
        },
        {
          key: 'response',
          title: t(`${k}.response`),
          minWidth: 72,
          priority: 1,
          align: 'end',
          listColumn: true,
          render: (row) => <CheckResponse facts={factsOf(row)} />,
        },
        {
          key: 'uptime',
          title: t(`${k}.columnUptime`),
          minWidth: 96,
          priority: 2,
          align: 'end',
          listColumn: true,
          render: (row) => <CheckUptime facts={factsOf(row)} />,
        },
        {
          key: 'state',
          title: t(`${k}.columnState`),
          minWidth: 152,
          priority: 4,
          align: 'end',
          listColumn: true,
          render: state,
        },
      ],
      card: {
        headerRight: state,
        body: {
          render: bars,
          heightAtNormalText: 24,
        },
        facts: (row) => <CheckCardFacts facts={factsOf(row)} />,
        // What it is, or why it fails (lab B2): the row's line 2 without its phone bars.
        description: (row) => (
          <CheckByline row={row} facts={factsOf(row)} scope={scope} stale={staleOf(row)} loading={settling} columns />
        ),
      },
      accessibilityLabel: (row) =>
        [factsOf(row).title, serviceCheckStatusWord(factsOf(row).status)].join(
          ', ',
        ),
      testID: (row) =>
        `services.checks.row.${row.automationId}.${row.triggerId}`,
      columnTitles: { title: t(`${k}.columnCheck`) },
    };
  }, [facts, input, scope, offlineObservers, settling]);
  return (
    <ServicesPageList<ManagedConfiguredCheckRow>
      testID={props.testID}
      model={model}
      anatomy={anatomy}
      accessibilityLabel={props.accessibilityLabel}
      presentation={props.presentation ?? 'list'}
    />
  );
}

/** Whether the State says something: paused, failing, degraded, waiting or stale. Healthy says nothing. */
function checkStateSpeaks(
  row: ManagedConfiguredCheckRow,
  facts: ServiceCheckListFacts,
  stale: boolean,
): boolean {
  return (
    !row.native.enabled ||
    stale ||
    serviceCheckStatusTone(facts.status) !== null ||
    facts.status === 'notChecked'
  );
}

/** A row's last checks as bars; dimmed while its observing Machine is offline (lab "stale observer"). */
const CheckRowBars = React.memo(function CheckRowBars(
  props: Readonly<{
    facts: ServiceCheckListFacts;
    stale: boolean;
    loading: boolean;
  }>,
) {
  const loading = props.loading || props.facts.status === 'loading';
  const cells = React.useMemo(
    (): readonly ServiceCheckBarCell[] =>
      props.facts.recent.bars.map((bar) => ({
        key: bar.key,
        tone: bar.tone,
        label: '',
      })),
    [props.facts.recent.bars],
  );
  return (
    <ServiceCheckBars
      cells={loading ? 'loading' : cells}
      slots={SERVICE_CHECK_ROW_BARS}
      size="inline"
      label={t(`${m}.columnRecent`, { count: SERVICE_CHECK_ROW_BARS })}
      partialLead={props.facts.recent.partialLead}
      stale={props.stale}
    />
  );
});

function CheckResponse(props: Readonly<{ facts: ServiceCheckListFacts }>) {
  const { theme } = useUnistyles();
  if (props.facts.latencyMs === null) return null;
  const tone =
    props.facts.status === 'degraded'
      ? theme.colors.state.warning.textForeground
      : theme.colors.text.secondary;
  return (
    <Text
      style={{
        ...Typography.variant('meta'),
        color: tone,
        fontVariant: ['tabular-nums'],
      }}
      numberOfLines={1}
    >
      {formatServiceCheckLatency(props.facts.latencyMs)}
    </Text>
  );
}

function CheckUptime(props: Readonly<{ facts: ServiceCheckListFacts }>) {
  const { theme } = useUnistyles();
  const text = serviceCheckUptimeText(props.facts.uptimePercent);
  if (text === null) return null;
  return (
    <Text
      style={{
        ...Typography.variant('label'),
        fontVariant: ['tabular-nums'],
        color:
          props.facts.status === 'down'
            ? theme.colors.state.danger.textForeground
            : theme.colors.text.primary,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}

/** A card's foot: uptime over 30 days, then the latest response. */
function CheckCardFacts(props: Readonly<{ facts: ServiceCheckListFacts }>) {
  const { theme } = useUnistyles();
  const uptime = serviceCheckUptimeText(props.facts.uptimePercent);
  const parts = [
    uptime ? t(`${m}.uptimeOverDays`, { percent: uptime }) : null,
    props.facts.latencyMs === null
      ? null
      : formatServiceCheckLatency(props.facts.latencyMs),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <Text
      style={{
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
      }}
      numberOfLines={1}
    >
      {parts.join(' · ')}
    </Text>
  );
}

/** A Check's state, said only when it needs saying: failing, degraded, paused, waiting, or stopped being checked. */
const CheckState = React.memo(function CheckState(
  props: Readonly<{
    row: ManagedConfiguredCheckRow;
    facts: ServiceCheckListFacts;
    stale: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { stale } = props;
  const quiet = (label: string) => (
    <Text
      style={{
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
      }}
      numberOfLines={1}
    >
      {label}
    </Text>
  );
  if (!props.row.native.enabled)
    return (
      <Status tone="muted" label={t(`${k}.paused`)} presentation="inline" />
    );
  const lastObservedAt =
    props.facts.recent.bars[props.facts.recent.bars.length - 1]?.observedAt ??
    null;
  if (stale && lastObservedAt !== null)
    return quiet(t(`${m}.staleState`, { time: formatMoment(lastObservedAt) }));
  const tone = serviceCheckStatusTone(props.facts.status);
  if (tone)
    return (
      <Status
        tone={tone}
        label={serviceCheckStatusWord(props.facts.status)}
        presentation="inline"
      />
    );
  if (props.facts.status === 'notChecked') return quiet(t(`${m}.waiting`));
  return null;
});

/**
 * Line 2: why it fails while it does (cause and since when, or how much slower than usual), which Machine stopped
 * checking it, else what it is (kind, cadence, from where). A phone has no columns, so a healthy row's line 2 draws the
 * bars and the uptime and response beside them (lab B3).
 */
const CheckByline = React.memo(function CheckByline(
  props: Readonly<{
    row: ManagedConfiguredCheckRow;
    facts: ServiceCheckListFacts;
    scope: ServerAccountScope | null;
    stale: boolean;
    loading: boolean;
    columns: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { facts, row, stale } = props;
  const observer = useServerScopedMachineLabel(
    props.scope?.serverId ?? null,
    facts.observerMachineId,
  );
  const named = facts.title !== row.native.name ? row.native.name : null;
  const every = facts.every
    ? observer
      ? t(`${k}.checkEvery`, { period: facts.every, machine: observer })
      : t(`${k}.checkEveryAnywhere`, { period: facts.every })
    : null;
  const failing = row.native.enabled && facts.status === 'down';
  const slow =
    row.native.enabled &&
    facts.status === 'degraded' &&
    facts.latencyMs !== null &&
    facts.usualMs !== null;
  const line =
    stale && observer
      ? t(`${m}.staleByline`, { machine: observer })
      : failing
        ? [
            facts.causeText,
            facts.failingSince === null
              ? null
              : t(`${m}.failingSince`, {
                  time: formatMoment(facts.failingSince),
                }),
          ]
            .filter(Boolean)
            .join(' · ') || null
        : slow
          ? t(`${m}.answersIn`, {
              latency: formatServiceCheckLatency(facts.latencyMs!),
              usual: formatServiceCheckLatency(facts.usualMs!),
            })
          : [facts.kind, named, every].filter(Boolean).join(' · ') || null;
  const meta = {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  } as const;
  // A phone row draws its bars and figures only while its state is silent (healthy); a row whose state speaks says why
  // on line 2 instead (lab B3 / A1p): both never fit one phone line.
  if (!props.columns && !checkStateSpeaks(row, facts, stale)) {
    const uptime = serviceCheckUptimeText(facts.uptimePercent);
    const figures = [
      uptime,
      facts.latencyMs === null
        ? null
        : formatServiceCheckLatency(facts.latencyMs),
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.s8,
          minWidth: 0,
        }}
      >
        <CheckRowBars facts={facts} stale={stale} loading={props.loading} />
        {figures ? (
          <Text
            style={{ ...meta, fontVariant: ['tabular-nums'] }}
            numberOfLines={1}
          >
            {figures}
          </Text>
        ) : null}
      </View>
    );
  }
  return line ? (
    <Text style={meta} numberOfLines={1}>
      {line}
    </Text>
  ) : null;
});
