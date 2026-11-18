import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  CollectionAnatomy,
  CollectionField,
  CollectionSummaryRow,
} from '@happier-dev/plugin-ui';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import type {
  MachineProcessesAnswerV1,
  ProcessOwnershipLevelV1,
  ProcessSampleV1,
  OwnerRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatVitalsPercent } from '@/components/machines/vitals/vitalsFormat';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

import { resolveOwnershipLabel } from './ownershipLabelPresentation';
import { ProcessPortChip } from './ProcessPortMenu';
import {
  describeEndedOwner,
  describeProcessIdentity,
  describeProcessTitle,
  processGlyphName,
  ProcessOwnerMark,
  useProcessOwnerStatus,
} from './processOwnerIdentity';
import {
  isProcessRowEmphasized,
  type MachineProcessesTotals,
  type ProcessesItem,
} from './processesPresentation';

/** Why a row came back after a stop that did not happen ("It didn't stop"), by row key; the tab provides it. */
export const ProcessesRowNotesContext = React.createContext<ReadonlyMap<string, string>>(new Map());

/** A trend is drawn only where something moves (lab `rp` H): a flat line is noise. */
const SPARK_MIN_SPREAD_PERCENT = 0.2;
/** The inline trend's width, and the points it draws: about one every 3 px, so a long sample run reads as a line. */
const SPARK_WIDTH_PX = 84;
const SPARK_POINTS = 28;

/** Mean CPU per equal slice of the sampled span; a slice with no reading stays a gap. */
function bucketSparkPoints(samples: readonly ProcessSampleV1[]): { id: string; x: number; y: number | null }[] {
  if (samples.length <= SPARK_POINTS) {
    return samples.map((sample) => ({ id: String(sample.capturedAtMs), x: sample.capturedAtMs, y: sample.cpuPercent ?? null }));
  }
  const times = samples.map((sample) => sample.capturedAtMs);
  const first = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - first);
  const sums = new Array<number>(SPARK_POINTS).fill(0);
  const counts = new Array<number>(SPARK_POINTS).fill(0);
  for (const sample of samples) {
    if (typeof sample.cpuPercent !== 'number') continue;
    const index = Math.min(SPARK_POINTS - 1, Math.floor(((sample.capturedAtMs - first) / span) * SPARK_POINTS));
    sums[index] += sample.cpuPercent;
    counts[index] += 1;
  }
  return sums.map((sum, index) => {
    const x = Math.round(first + ((index + 0.5) / SPARK_POINTS) * span);
    return { id: String(x), x, y: counts[index]! > 0 ? sum / counts[index]! : null };
  });
}

export type ProcessesAnatomyInput = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  /** Owner titles from {@link useProcessOwnerTitles}. */
  titles: ReadonlyMap<string, string>;
  cpuCapacityCores: number | null;
  history?: MachineProcessesAnswerV1['history'];
  /** A phone row: CPU and the status under the name, memory at the right (lab `rp` Hp). */
  compact: boolean;
  /**
   * With `compact`: the memory stands at the end of the name's own line (a widget's rows, lab `rw` C), not at the end
   * of the line beneath it as on the phone's tab.
   */
  memoryOnTitleLine?: boolean;
  /**
   * With `compact`: one line per row (a widget's "Using the most", lab `rw` C): the name, its status inline after it
   * and the memory at the end, through the Collection's single-line list row. No CPU line beneath.
   */
  singleLine?: boolean;
  /** The same rows with nothing to act on (Overview's "Using the most", plan 60's tool body). */
  readOnly?: boolean;
  /** Rows leave through this wrapper (stop-and-ease); read-only callers omit it. */
  wrapItem?: (item: ProcessesItem, content: React.ReactNode) => React.ReactNode;
}>;

const ABSENT_FIGURE = '—';

export function formatProcessCpu(value: number | null): string {
  return value === null ? ABSENT_FIGURE : `${formatVitalsPercent(value)}%`;
}

export function formatProcessMemory(value: number | null, ceiling?: OwnerRowV1['ceiling']): string {
  if (ceiling) return t('machineProcesses.ceiling.usage', {
    used: ceiling.usedBytes === undefined ? '—' : formatMachineBytes(ceiling.usedBytes, 'memory'),
    limit: formatMachineBytes(ceiling.limitBytes, 'memory'),
  });
  return value === null ? ABSENT_FIGURE : formatMachineBytes(value, 'memory');
}

/** The name a row shows: owners by the identity owner, processes in plain words, groups by what they are. */
export function describeProcessesItemTitle(
  item: ProcessesItem,
  titles: ReadonlyMap<string, string>,
): string {
  switch (item.kind) {
    case 'owner':
      return titles.get(item.owner.rowId) ?? item.owner.rowId;
    case 'process':
      return describeProcessTitle(item.row);
    case 'leftBehind':
      return describeProcessTitle(item.row);
    case 'fold':
      return item.reason === 'mcp'
        ? t('machineProcesses.fold.mcp', { count: item.count })
        : t('machineProcesses.fold.idle', { count: item.count });
    case 'happier':
      return t('machineProcesses.owners.happier');
    case 'app':
      return item.app.appGroup;
    case 'appMember':
      return item.row.name;
    case 'otherPeople':
      return item.names.length > 0
        ? item.names.join(', ')
        : t('machineProcesses.allRows.otherPeopleFallback');
  }
}

function levelOf(item: ProcessesItem): ProcessOwnershipLevelV1 {
  if (item.kind === 'process') return item.row.level;
  if (item.kind === 'leftBehind') return 'left_behind';
  if (item.kind === 'owner') return 'proven';
  return 'not_happier';
}

function describeRowDetail(item: ProcessesItem): string {
  const label =
    item.kind === 'process' || item.kind === 'leftBehind'
      ? resolveOwnershipLabel(levelOf(item))
      : null;
  return label ? t(label.labelKey) : '';
}

/** The quiet ownership word + glyph, only where ownership is not proven (R14). */
export const ProcessOwnershipPill = React.memo(function ProcessOwnershipPill(
  props: Readonly<{ level: ProcessOwnershipLevelV1; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const label = resolveOwnershipLabel(props.level);
  if (!label) return null;
  const color =
    label.variant === 'attention'
      ? (theme.colors.state.attention.textForeground ??
        theme.colors.state.attention.foreground)
      : theme.colors.text.secondary;
  return (
    <StatusPill
      testID={props.testID}
      chrome="plain"
      variant={label.variant}
      labelVariant="phrase"
      label={t(label.labelKey)}
      foregroundColor={color}
      leading={<Icon name={label.icon} size={12} color={color} />}
    />
  );
});

/**
 * A listener on the process that owns it (`:5173`), in the mono chip the lab draws. Given the row it
 * sits on (the tab's tree, not a read-only surface), each chip opens its Local services menu.
 */
export const ProcessPortChips = React.memo(function ProcessPortChips(
  props: Readonly<{
    ports: readonly Readonly<{ port: number; inventoryEntryId?: string }>[];
    actionable?: Readonly<{ item: ProcessesItem; ownerTitle: string }>;
    /** A row keeps its first listener; the rest say how many more the rows it opens (and its detail) list. */
    max?: number;
    /** The row the count belongs to, for its test id. */
    rowKey?: string;
  }>,
) {
  // On the tab's rows the count is a button: it shows the rest of the row's listeners in place, each its own chip and menu.
  const [showAll, setShowAll] = React.useState(false);
  if (props.ports.length === 0) return null;
  const { actionable } = props;
  const shown = props.max === undefined || showAll ? props.ports : props.ports.slice(0, props.max);
  const hidden = props.ports.length - shown.length;
  return (
    <>
      {shown.map((port) =>
        actionable && port.inventoryEntryId ? (
          <ProcessPortChip
            key={port.port}
            port={port.port}
            inventoryEntryId={port.inventoryEntryId}
            item={actionable.item}
            ownerTitle={actionable.ownerTitle}
          />
        ) : (
          <StatusPill
            key={port.port}
            variant="neutral"
            hideDot
            label={`:${port.port}`}
            labelStyle={styles.mono}
          />
        ),
      )}
      {hidden > 0 && !actionable ? (
        // A read-only row (the Overview's preview) is itself the press target: the count stays text inside it.
        <Text
          testID={props.rowKey ? `machine-processes-ports-more-${props.rowKey}` : undefined}
          numberOfLines={1}
          accessibilityLabel={props.ports.slice(shown.length).map((port) => `:${port.port}`).join(', ')}
          style={styles.moreChips}
        >{`+${hidden}`}</Text>
      ) : hidden > 0 ? (
        <HappierPressable
          testID={props.rowKey ? `machine-processes-ports-more-${props.rowKey}` : undefined}
          accessibilityRole="button"
          accessibilityLabel={props.ports.slice(shown.length).map((port) => `:${port.port}`).join(', ')}
          // The row opens on its own press; the count only reveals its ports.
          onPress={(event) => { event?.stopPropagation?.(); setShowAll(true); }}
        >
          <Text numberOfLines={1} style={styles.moreChips}>{`+${hidden}`}</Text>
        </HappierPressable>
      ) : null}
    </>
  );
});

/** The chip's menu for rows of the tab's tree; read-only surfaces draw the chip alone. */
function portActions(
  input: ProcessesAnatomyInput,
  item: ProcessesItem,
  ownerRowId: string,
): Readonly<{ item: ProcessesItem; ownerTitle: string }> | undefined {
  return input.readOnly
    ? undefined
    : { item, ownerTitle: input.titles.get(ownerRowId) ?? ownerRowId };
}

const ROW_PORT_CHIPS = 1;

/**
 * A row's listeners. On the tab's tree each chip opens its menu, so the Collection draws them as the row's
 * `titleControls`, beside its press target; a read-only surface keeps the plain chips in the row's line.
 * Every row keeps one chip and a count, so its name and what it is doing stay readable; the rows it opens
 * and its detail list every listener.
 */
const ProcessRowPorts = React.memo(function ProcessRowPorts(
  props: Readonly<{ item: ProcessesItem; input: ProcessesAnatomyInput }>,
) {
  const { item, input } = props;
  switch (item.kind) {
    case 'owner':
      return (
        <ProcessPortChips
          ports={item.ports}
          actionable={portActions(input, item, item.owner.rowId)}
          max={ROW_PORT_CHIPS}
          rowKey={item.key}
        />
      );
    case 'process':
      return (
        <ProcessPortChips
          ports={item.row.ports ?? []}
          actionable={portActions(input, item, item.owner.rowId)}
          max={ROW_PORT_CHIPS}
          rowKey={item.key}
        />
      );
    case 'leftBehind':
      // On a phone the line says why the row is here (its session and when it ended); the ports are on the review.
      return (
        <ProcessPortChips
          ports={input.compact ? [] : (item.row.ports ?? [])}
          actionable={portActions(input, item, item.key)}
          max={ROW_PORT_CHIPS}
          rowKey={item.key}
        />
      );
    default:
      return null;
  }
});

/** The rest of a row's line: a session's status word or what a process is running, its label and (read-only) its ports. */
const ProcessRowWhere = React.memo(function ProcessRowWhere(
  props: Readonly<{ item: ProcessesItem; input: ProcessesAnatomyInput }>,
) {
  const { item, input } = props;
  switch (item.kind) {
    case 'owner':
      return <OwnerWhere item={item} input={input} />;
    case 'process': {
      const identity = describeProcessIdentity(item.row);
      return (
        <View style={styles.where}>
          {identity ? <Text numberOfLines={1} style={styles.quiet}>{identity}</Text> : null}
          {item.row.driverLabel || item.row.command && !input.compact ? (
            <Text numberOfLines={1} style={styles.command}>
              {item.row.driverLabel ?? item.row.command}
            </Text>
          ) : null}
          <ProcessOwnershipPill level={item.row.level} testID={`machine-processes-label-${item.key}`} />
          {input.readOnly ? <ProcessRowPorts item={item} input={input} /> : null}
        </View>
      );
    }
    case 'leftBehind':
      return (
        <View style={styles.where}>
          <LeftBehindOwnerLine item={item} serverId={input.serverId} />
          {input.readOnly ? <ProcessRowPorts item={item} input={input} /> : null}
        </View>
      );
    case 'happier':
      return (
        <Text numberOfLines={1} style={styles.quiet}>
          {t('machineProcesses.allRows.happier', {
            owners: item.ownerCount,
            processes: item.processCount,
          })}
        </Text>
      );
    case 'app':
    case 'otherPeople':
      return (
        <Text numberOfLines={1} style={styles.quiet}>
          {t('machineProcesses.owners.processCount', { count: item.count })}
        </Text>
      );
    default:
      return null;
  }
});

function OwnerWhere(
  props: Readonly<{
    item: Extract<ProcessesItem, { kind: 'owner' }>;
    input: ProcessesAnatomyInput;
  }>,
) {
  const { item, input } = props;
  const note = React.useContext(ProcessesRowNotesContext).get(item.key);
  const { theme } = useUnistyles();
  const status = useProcessOwnerStatus(item.owner.owner, input.serverId);
  const stopping = item.owner.state === 'stopping';
  const text = note ?? (
    item.matchCount !== null
      ? t('machineProcesses.owners.matches', {
          count: item.matchCount,
          total: item.processCount,
        })
      : stopping
        ? t('machineProcesses.owners.stopping')
        : item.owner.owner.kind === 'happier' && !item.owner.owner.component
          ? // The phone's line is the CPU and the ports (lab `rp` Hp); what Happier is for reads in the table.
            input.compact
            ? null
            : t('machineProcesses.owners.keepsConnected', {
                machine: input.machineName,
              })
          : status && item.hasChildren
            ? t('machineProcesses.owners.statusWithCount', {
                status: status.text,
                count: item.processCount,
              })
            : (status?.text ??
              (item.hasChildren
                ? t('machineProcesses.owners.processCount', {
                    count: item.processCount,
                  })
                : null)));
  return (
    <View style={styles.where}>
      {text ? (
        <Text
          numberOfLines={1}
          style={[
            styles.quiet,
            note
              ? { color: theme.colors.state.attention.textForeground }
              : status?.color && !stopping && item.matchCount === null
                ? { color: status.color }
                : null,
          ]}
        >
          {text}
        </Text>
      ) : null}
      {input.readOnly ? <ProcessRowPorts item={item} input={input} /> : null}
    </View>
  );
}

function LeftBehindOwnerLine(
  props: Readonly<{
    item: Extract<ProcessesItem, { kind: 'leftBehind' }>;
    serverId: string;
  }>,
) {
  const owner = props.item.row.owner;
  const addresses = React.useMemo(
    () =>
      owner.kind === 'session'
        ? [{ sessionId: owner.sessionId, serverId: props.serverId }]
        : [],
    [owner, props.serverId],
  );
  const [title] = useSessionDisplayTitles(addresses);
  const isSessionVisible = useSessionRecordingVisibility();
  const when = formatRelativeTimeShort(
    props.item.row.confirmedAtMs,
    Date.now(),
  );
  return (
    <Text numberOfLines={2} style={styles.quiet}>
      {t('machineProcesses.leftBehindRow', {
        owner: owner.kind === 'session' && !isSessionVisible({ sessionId: owner.sessionId, serverId: props.serverId })
          ? describeEndedOwner(owner) : title ?? describeEndedOwner(owner),
        when,
      })}
    </Text>
  );
}

/** CPU or memory, tabular at the end; a row that uses a full core or was left behind reads in ink. */
const ProcessFigure = React.memo(function ProcessFigure(
  props: Readonly<{ text: string; strong: boolean; testID?: string }>,
) {
  // A figure the answer does not carry (a daemon's CPU) is the quiet dash of an empty cell, never a bold one.
  const absent = props.text === ABSENT_FIGURE;
  return (
    <Text
      testID={props.testID}
      numberOfLines={1}
      style={[styles.figure, absent ? styles.figureAbsent : props.strong ? styles.figureStrong : null]}
    >
      {props.text}
    </Text>
  );
});

/** The inline trend through the one chart owner, only where something moves. */
const ProcessSpark = React.memo(function ProcessSpark(
  props: Readonly<{
    samples: readonly ProcessSampleV1[] | undefined;
    label: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const series = React.useMemo((): readonly HappierSeries[] | null => {
    const values = (props.samples ?? []).flatMap((sample) =>
      typeof sample.cpuPercent === 'number' ? [sample.cpuPercent] : [],
    );
    if (
      values.length < 2 ||
      Math.max(...values) - Math.min(...values) < SPARK_MIN_SPREAD_PERCENT
    )
      return null;
    return [
      {
        id: 'cpu',
        label: props.label,
        color: theme.colors.text.secondary,
        points: bucketSparkPoints(props.samples ?? []),
      },
    ];
  }, [props.label, props.samples, theme.colors.text.secondary]);
  if (!series) return null;
  return (
    <StackedSeriesChart
      theme={pluginTheme}
      label={props.label}
      series={series}
      variant="line"
      size="inline"
      fitLine
      width={SPARK_WIDTH_PX}
    />
  );
});

function figureStrong(
  item: ProcessesItem,
  cpuCapacityCores: number | null,
): boolean {
  if (item.kind === 'owner' || item.kind === 'happier' || item.kind === 'app') return true;
  return isProcessRowEmphasized(
    { cpuPercent: item.cpuPercent, level: levelOf(item) },
    cpuCapacityCores,
  );
}

function ProcessGlyph(
  props: Readonly<{ item: ProcessesItem; input: ProcessesAnatomyInput }>,
) {
  const { theme } = useUnistyles();
  const { item, input } = props;
  if (item.kind === 'owner')
    return (
      <ProcessOwnerMark
        owner={item.owner.owner}
        serverId={input.serverId}
        machineId={input.machineId}
      />
    );
  if (item.kind === 'happier')
    return (
      <Icon name="crosshair" size={16} color={theme.colors.text.secondary} />
    );
  if (item.kind === 'app')
    return (
      <Icon name="desktop" size={16} color={theme.colors.text.secondary} />
    );
  if (item.kind === 'otherPeople')
    return <Icon name="lock" size={16} color={theme.colors.text.tertiary} />;
  if (item.kind === 'fold') return null;
  const glyph =
    item.kind === 'appMember' ? null : processGlyphName(item.row.role);
  return glyph ? (
    <Icon name={glyph} size={16} color={theme.colors.text.secondary} />
  ) : (
    <StatusDot color={theme.colors.text.tertiary} size={5} />
  );
}

/**
 * The one row anatomy for Processes (plan 30 §10.1): the tab's tree, the Overview's "Using the most"
 * (VU-7, `readOnly` + owners only) and plan 60's tool body all draw these rows. Sorting is the caller's:
 * pass {@link buildMachineProcessesView}'s items; CPU and Memory headers sort when the Collection is given `sort`.
 */
export function useProcessesCollectionAnatomy(
  input: ProcessesAnatomyInput,
): CollectionAnatomy<ProcessesItem> {
  const language = usePreferredLanguage();
  return React.useMemo((): CollectionAnatomy<ProcessesItem> => {
    const title = (item: ProcessesItem) =>
      describeProcessesItemTitle(item, input.titles);
    const cpu = (item: ProcessesItem) => (
      <ProcessFigure
        text={formatProcessCpu(item.cpuPercent)}
        strong={figureStrong(item, input.cpuCapacityCores)}
      />
    );
    const memory = (item: ProcessesItem) => (
      <ProcessFigure
        testID={`machine-processes-memory-${item.key}`}
        text={formatProcessMemory(item.memoryBytes, item.kind === 'owner' ? item.owner.ceiling : undefined)}
        strong={figureStrong(item, input.cpuCapacityCores)}
      />
    );
    const historyOf = (item: ProcessesItem) =>
      item.kind === 'owner'
        ? input.history?.[item.owner.rowId]
        : item.kind === 'process'
          ? input.history?.[item.row.ref]
          : undefined;
    const memoryField: CollectionField<ProcessesItem> = {
      key: 'memory',
      title: t('machineProcesses.columns.memory'),
      minWidth: 72,
      priority: 4,
      align: 'end',
      sortable: true,
      render: memory,
    };
    // Phone (lab `rp` Hp): the rows say memory in their trailing slot; the field is still declared, so the
    // list's summary rows ("Happier in total", "Everything else") and its sort keep the same figure.
    const fields: CollectionField<ProcessesItem>[] = input.compact
      ? [memoryField]
      : [
          ...(input.history
            ? [
                {
                  key: 'trend',
                  title: t('machineProcesses.columns.trend'),
                  minWidth: 84,
                  priority: 1,
                  render: (item: ProcessesItem) => (
                    <ProcessSpark
                      samples={historyOf(item)}
                      label={title(item)}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'cpu',
            title: t('machineProcesses.columns.cpu'),
            minWidth: 56,
            priority: 3,
            align: 'end',
            sortable: true,
            render: cpu,
          },
          memoryField,
        ];
    return {
      glyph: (item) => <ProcessGlyph item={item} input={input} />,
      title,
      ...(input.compact && input.singleLine
        ? {
            titleSuffix: (item: ProcessesItem) => (
              <ProcessRowWhere item={item} input={input} />
            ),
            titleMeta: memory,
          }
        : input.compact
        ? {
            // Phone (lab `rp` Hp): the name takes the row, CPU and the status beneath, memory at the right.
            byline: (item: ProcessesItem) => (
              <View style={[styles.where, styles.clip]}>
                {item.cpuPercent === null ? null : (
                  <Text
                    numberOfLines={1}
                    style={[styles.quiet, styles.cpuLine]}
                  >{`${formatProcessCpu(item.cpuPercent)} ${t('machineProcesses.columns.cpu')}`}</Text>
                )}
                <ProcessRowWhere item={item} input={input} />
              </View>
            ),
            ...(input.memoryOnTitleLine ? { titleMeta: memory } : { reason: memory }),
          }
        : {
            // The table keeps the status, command, label and ports on the title line (lab `rp` H); a table too
            // narrow for its columns says them on the list row's second line.
            titleSuffix: (item: ProcessesItem) => (
              <ProcessRowWhere item={item} input={input} />
            ),
            byline: (item: ProcessesItem) => (
              <ProcessRowWhere item={item} input={input} />
            ),
          }),
      ...(input.readOnly
        ? {}
        : { titleControls: (item: ProcessesItem) => <ProcessRowPorts item={item} input={input} /> }),
      fields,
      accessibilityLabel: (item) =>
        t('machineProcesses.a11y.row', {
          name: title(item),
          detail: describeRowDetail(item),
          cpu: formatProcessCpu(item.cpuPercent),
          memory: formatProcessMemory(item.memoryBytes),
        }),
      testID: (item) => `machine-processes-row-${item.key}`,
      columnTitles: { title: t('machineProcesses.columns.happier') },
      ...(input.wrapItem && !input.readOnly
        ? { wrapItem: input.wrapItem }
        : {}),
    };
  }, [language, input]);
}

/** "Happier in total" and "Everything else on <machine>" (lab `rp` H; VU-7's two closing rows). */
export function buildProcessesSummaryRows(
  input: Readonly<{
    totals: MachineProcessesTotals;
    machineName: string;
    /** The way into All processes on the second row ("Show all processes"), where the viewer may use it. */
    showAll?: React.ReactNode;
    /** The way into the Processes tab on the first row (Overview's "N in Processes", lab `rv` O). */
    happierLink?: React.ReactNode;
  }>,
): readonly CollectionSummaryRow[] {
  const { totals } = input;
  return [
    {
      key: 'happier-total',
      testID: 'machine-processes-total-happier',
      title: input.happierLink ? (
        <View style={styles.where}>
          <Text style={styles.quiet}>{t('machineProcesses.totals.happier')}</Text>
          {input.happierLink}
        </View>
      ) : (
        t('machineProcesses.totals.happier')
      ),
      cells: {
        cpu: (
          <ProcessFigure
            text={formatProcessCpu(totals.happier.cpuPercent)}
            strong={false}
          />
        ),
        memory: (
          <ProcessFigure
            testID="machine-processes-total-happier-memory"
            text={formatProcessMemory(totals.happier.memoryBytes)}
            strong={false}
          />
        ),
      },
    },
    {
      key: 'everything-else',
      testID: 'machine-processes-total-else',
      title: (
        <View style={styles.where}>
          <Text style={styles.quiet}>
            {t('machineProcesses.totals.everythingElse', {
              machine: input.machineName,
            })}
          </Text>
          {input.showAll}
        </View>
      ),
      cells: {
        cpu: (
          <ProcessFigure
            text={formatProcessCpu(totals.everythingElse.cpuPercent)}
            strong={false}
          />
        ),
        memory: (
          <ProcessFigure
            text={formatProcessMemory(totals.everythingElse.memoryBytes)}
            strong={false}
          />
        ),
      },
    },
  ];
}

const styles = StyleSheet.create((theme) => ({
  // A totals row's sentence and its link share the line while they fit; on a phone the link drops under the
  // sentence instead of either being cut ("Show all processes" is a control, the machine name an identity).
  where: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    minWidth: 0,
    flexShrink: 1,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  // The phone line's CPU figure never gives its width to the status or chips beside it.
  cpuLine: {
    flexShrink: 0,
  },
  clip: {
    overflow: 'hidden',
  },
  moreChips: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
  command: {
    ...Typography.mono(),
    ...Typography.variant('meta'),
    fontFamily: Typography.mono().fontFamily,
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  mono: {
    ...Typography.mono(),
  },
  figure: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
  figureStrong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  figureAbsent: {
    color: theme.colors.text.tertiary,
  },
}));
