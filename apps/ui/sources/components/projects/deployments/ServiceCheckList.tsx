import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';
import { HAPPIER_DATA_METRICS } from '@happier-dev/plugin-ui/presentation';
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
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { buildServiceCheckHref } from './deploymentNavigation';
import {
  SERVICES_ONE_SHEET,
  ServicesPageList,
} from './DeploymentEnvironmentRows';
import { ServiceCheckBars, type ServiceCheckBarCell } from './ServiceCheckBars';
import { ServiceCheckDetail, useServiceCheckMeta } from './ServiceCheckDetail';
import { ServiceCheckResponseTrend } from './ServiceCheckResponseTrend';
import { formatServiceCheckMoment } from './formatServiceCheckMoment';
import { useServiceCheckOfflineObservers } from './useServiceCheckOfflineObservers';
import {
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
  // What the Check is stands under its name in the pane's band, as on its page (lab A3), not as the body's first line.
  const meta = useServiceCheckMeta(shown);
  const details = React.useMemo(
    () =>
      shown
        ? {
            header: {
              title: serviceCheckListFacts(shown).title,
              ...(meta ? { subtitle: meta } : {}),
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
                <ServiceCheckDetail row={shown} metaInHeader />
              </ItemList>
            ),
          }
        : null,
    [meta, openCheckPage, shown],
  );
  return { selection, details, closeCheck };
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
      // A name (a named Key flow, a saved name) wraps as a name.
      titleIdentifier: (row) => factsOf(row).titleIdentifier,
      // Its target arrives with its definition: until then the title's place holds the loading bar, never the saved
      // automation's name it would then flip from.
      titlePending: (row) => settling || row.definitionFacts.kind === 'loading',
      // Line 2 says what the check is, or why it fails when it does; a phone (no columns) also draws its bars there.
      // A row with nothing to say on line 2 passes no line, so a speaking state word stands alone instead of
      // trailing a separator before an empty element (PAGE-ACCEPT-176 R3-D7).
      byline: (row, layout) => checkBylineEmpty(row, factsOf(row), staleOf(row), layout?.fieldColumns === true) ? null : (
        <CheckByline
          row={row}
          facts={factsOf(row)}
          scope={scope}
          stale={staleOf(row)}
          loading={settling}
          columns={layout?.fieldColumns === true}
          resultInColumn={layout?.shownColumnKeys?.has('response') === true}
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
          title: t(`${m}.columnResponse24h`),
          minWidth: 152,
          priority: 1,
          align: 'end',
          listColumn: true,
          render: (row) => <CheckResponse facts={factsOf(row)} scope={row.scope} />,
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
          // A long state ("Not checked since Nov 15, 4:26 PM") takes the row's second line, never an ellipsis (R2-D13).
          render: (row) => settling ? null : <CheckState row={row} facts={factsOf(row)} stale={staleOf(row)} column />,
        },
      ],
      card: {
        headerRight: state,
        // D36 2B: the response area and its latest value with 30-day uptime, then the last checks.
        body: {
          render: (row) => <CheckCardBody facts={factsOf(row)} scope={row.scope} bars={bars(row)} />,
          heightAtNormalText: HAPPIER_DATA_METRICS.plotHeightPx + HAPPIER_DATA_METRICS.blockGapPx + 24,
        },
        // The value and uptime sit beside the trend in the body, so the card has no facts line. Without this the
        // card falls back to its byline as the foot and says line 2 twice.
        facts: () => null,
        // What it is, or why it fails (lab B2): the row's line 2 without its phone bars; the body states the result.
        description: (row) => (
          <CheckByline row={row} facts={factsOf(row)} scope={scope} stale={staleOf(row)} loading={settling} columns resultInColumn />
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
    facts.status === 'notChecked' ||
    facts.status === 'unknown' ||
    facts.observationDisclosure !== null
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

/**
 * The saved check's own result, as Monitoring states it: its value (a Key flow's measured value in the unit of its
 * measure), the colour of a failing result, the window and limit it was judged on, and what the line beside it shows —
 * a Key flow's separately windowed collector history, or the check's own retained responses.
 */
/** Whether the measured value is the failure itself (a Key flow over its limit), not a status failure beside it (D8). */
function valueIsTheFailure(facts: ServiceCheckListFacts): boolean {
  // Only a Key flow has a rule; its measured value is what the rule judged.
  return facts.ruleText !== null && facts.valueText !== null;
}

function useCheckResult(facts: ServiceCheckListFacts) {
  const { theme } = useUnistyles();
  const value = facts.valueText ?? (facts.latencyMs === null ? null : formatServiceCheckLatency(facts.latencyMs));
  // Only a failing rule that measures the response tones it; a status failure (a 502) leaves a normal latency ink (D8).
  const tone = !valueIsTheFailure(facts) ? null : facts.lastTone === 'danger' ? theme.colors.state.danger.textForeground
    : facts.lastTone === 'warning' ? theme.colors.state.warning.textForeground : null;
  const history = facts.collectorTrend ? t(`${m}.collectorHistory24h`) : t(`${m}.columnResponse24h`);
  return { value, tone, history, readout: [value, facts.ruleText, history].filter(Boolean).join(' · ') };
}

/** Response · 24 h (D36 2A): the saved result leads (said once, in its tone), then the history as a small ink line. */
function CheckResponse(props: Readonly<{ facts: ServiceCheckListFacts; scope: ManagedConfiguredCheckRow['scope'] }>) {
  const { theme } = useUnistyles();
  const { collectorTrend, latencyMs } = props.facts;
  const result = useCheckResult(props.facts);
  // A saved route check can measure error rate and still have a collector latency series for Response.
  if (latencyMs === null && result.value === null && collectorTrend?.config.measure.kind !== 'route') return null;
  return (
    <View accessible accessibilityLabel={result.readout}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
      <ServiceCheckResponseTrend facts={props.facts} scope={props.scope} form="line" label={result.history} />
      {result.value === null ? null : (
        <Text
          style={{
            ...Typography.variant('meta'),
            color: result.tone ?? theme.colors.text.secondary,
            fontVariant: ['tabular-nums'],
          }}
          numberOfLines={1}
        >
          {result.value}
        </Text>
      )}
    </View>
  );
}

/** The 30-day uptime stays ink: the State column and the bars say a failure; the figure is history, not an alarm. */
function CheckUptime(props: Readonly<{ facts: ServiceCheckListFacts }>) {
  const { theme } = useUnistyles();
  const text = serviceCheckUptimeText(props.facts.uptimePercent) ?? '—';
  return (
    <Text
      style={{
        ...Typography.variant('label'),
        fontVariant: ['tabular-nums'],
        color: theme.colors.text.primary,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}

/** A card's response area beside its latest value and 30-day uptime (D36 2B); a kind without response times keeps the facts. */
function CheckCardBody(props: Readonly<{ facts: ServiceCheckListFacts; scope: ManagedConfiguredCheckRow['scope']; bars: React.ReactNode }>) {
  return (
    <View style={{ gap: HAPPIER_DATA_METRICS.blockGapPx }}>
      <CheckCardFacts facts={props.facts} scope={props.scope} />
      {props.bars}
    </View>
  );
}

function CheckCardFacts(props: Readonly<{ facts: ServiceCheckListFacts; scope: ManagedConfiguredCheckRow['scope'] }>) {
  const { theme } = useUnistyles();
  const uptime = serviceCheckUptimeText(props.facts.uptimePercent);
  const result = useCheckResult(props.facts);
  if (!uptime && !result.value) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.s12, minHeight: HAPPIER_DATA_METRICS.plotHeightPx }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ServiceCheckResponseTrend facts={props.facts} scope={props.scope} form="area" label={result.history} />
      </View>
      {/* The saved result leads the card's figures; the description above says the window and limit it was judged on. */}
      <View style={{ alignItems: 'flex-end' }} accessible accessibilityLabel={[result.readout, uptime ? t(`${m}.uptimeOverDays`, { percent: uptime }) : null].filter(Boolean).join(' · ')}>
        {result.value ? (
          <Text style={{ ...Typography.variant('label', 'semiBold'), color: result.tone ?? theme.colors.text.primary, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
            {result.value}
          </Text>
        ) : null}
        {uptime ? (
          <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
            {t(`${m}.uptimeOverDays`, { percent: uptime })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const CheckState = React.memo(function CheckState(
  props: Readonly<{
    row: ManagedConfiguredCheckRow;
    facts: ServiceCheckListFacts;
    stale: boolean;
    /** In the State column, which has the row's two lines to hold it. */
    column?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { stale } = props;
  const quiet = (label: string) => (
    <Text
      style={{
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        ...(props.column ? { textAlign: 'right' as const } : null),
      }}
      numberOfLines={props.column ? 2 : 1}
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
    return quiet(t(`${m}.staleState`, { time: formatServiceCheckMoment(lastObservedAt) }));
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
  if (props.facts.status === 'unknown') return quiet(serviceCheckStatusWord(props.facts.status));
  return null;
});

/** Whether {@link CheckByline} would draw nothing: the same branches, decided before it mounts. */
function checkBylineEmpty(row: ManagedConfiguredCheckRow, facts: ServiceCheckListFacts, stale: boolean, columns: boolean): boolean {
  if (!columns && !checkStateSpeaks(row, facts, stale)) return false;
  if (stale && facts.observerMachineId) return false;
  if (row.native.enabled && facts.observationDisclosure) return false;
  const failing = row.native.enabled && (facts.status === 'down' || (facts.status === 'degraded' && facts.causeText !== null));
  if (failing) return !facts.causeText && facts.failingSince === null;
  const slow = row.native.enabled && facts.status === 'degraded' && facts.latencyMs !== null && facts.usualMs !== null;
  return !slow && !facts.kind && !facts.every;
}

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
    /** The Response column states the saved result: line 2 then says what it was judged on, not the value again. */
    resultInColumn?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { facts, row, stale } = props;
  const observer = useServerScopedMachineLabel(
    props.scope?.serverId ?? null,
    facts.observerMachineId,
  );
  const every = facts.every
    ? observer
      ? t(`${k}.checkEvery`, { period: facts.every, machine: observer })
      : t(`${k}.checkEveryAnywhere`, { period: facts.every })
    : null;
  // A failing row says why: its cause (a Key flow's measurement) and since when. A degraded row without a cause says
  // how much slower it answers than usual.
  const failing = row.native.enabled && (facts.status === 'down' || (facts.status === 'degraded' && facts.causeText !== null));
  const slow =
    row.native.enabled &&
    !failing &&
    facts.status === 'degraded' &&
    facts.latencyMs !== null &&
    facts.usualMs !== null;
  const line =
    stale && observer
      ? t(`${m}.staleByline`, { machine: observer })
      : failing
        ? [
            // With a Key flow's value in its column, line 2 names the rule the way a healthy Key flow names itself
            // (D9); any other failure says its cause, its title already naming its kind.
            props.resultInColumn && valueIsTheFailure(facts)
              ? [facts.kind, facts.ruleText ?? facts.causeText].filter(Boolean).join(' · ') : facts.causeText,
            facts.failingSince === null
              ? null
              : t(`${m}.failingSince`, {
                  time: formatServiceCheckMoment(facts.failingSince),
                }),
          ]
            .filter(Boolean)
            .join(' · ') || null
        : slow
          ? t(`${m}.answersIn`, {
              latency: formatServiceCheckLatency(facts.latencyMs!),
              usual: formatServiceCheckLatency(facts.usualMs!),
            })
          // What it reaches is meta beside how often (R12-D5); a title that is the address, or already says the kind, is
          // not repeated. How often stays whole; the address ends the line, where an ellipsis cuts only its tail.
          : (row.native.enabled ? facts.observationDisclosure : null)
            ?? ([facts.kind && !facts.title.startsWith(facts.kind) ? facts.kind : null,
              every, facts.targetMeta].filter(Boolean).join(' · ') || null);
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
  // Why a check fails is the row's message: in the table it takes a second line rather than ending mid-cause
  // ("checked fr…", PAGE-ACCEPT-176 R2-D13); what a healthy check is stays one line. A narrow list's line follows its
  // state word on the same line, so it stays one line there.
  // A failure the Response column does not state (a 502, a timeout) speaks here, in its tone; only a Key flow's
  // measured value, which is its failure, carries the tone in its column instead (D8, as `useCheckResult` decides).
  const causeTone = failing && !(props.resultInColumn && valueIsTheFailure(facts))
    ? facts.lastTone === 'danger' ? theme.colors.state.danger.textForeground
      : facts.lastTone === 'warning' ? theme.colors.state.warning.textForeground : null : null;
  return line ? (
    <Text style={causeTone ? { ...meta, color: causeTone } : meta} numberOfLines={props.columns && (failing || (stale && observer)) ? 2 : 1}>
      {line}
    </Text>
  ) : null;
});
