import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionSummaryRow,
} from '@happier-dev/plugin-ui';
import { CapacityBar, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { useProcessesCollectionAnatomy } from '@/components/machines/processes/processesCollectionAnatomy';
import { ProcessRowPresence } from '@/components/machines/processes/processesMotion';
import type { ProcessesItem } from '@/components/machines/processes/processesPresentation';
import { machineBytesParts } from '@/components/machines/vitals/machineVitalsPresentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { t } from '@/text';

import {
  MachineWidgetState,
  type MachineWidgetFreshness,
  type MachineWidgetMachineFacts,
} from './machineWidgetKit';

/**
 * What the two process widgets (Using the most, Left behind) share: how the one process store's state
 * becomes a widget state, the hero figure and the Processes tab's own rows. Pure presentation over
 * `useMachineProcesses` (plan 30); nothing here reads or watches.
 */

export type MachineProcessesWidgetState = ReturnType<
  typeof useMachineProcesses
>;

/** The live answer the rows draw from; an offline machine keeps the last one it sent (lab "last known"). */
export function readMachineProcessesWidgetAnswer(
  processes: MachineProcessesWidgetState,
): MachineProcessesAnswerV1 | null {
  return processes.answer?.state === 'live' ? processes.answer : null;
}

/** Freshness only when not live: offline, or a retained answer whose refresh failed ("As of …"). */
export function readMachineProcessesWidgetFreshness(
  processes: MachineProcessesWidgetState,
  online: boolean | null,
): MachineWidgetFreshness {
  const answer = readMachineProcessesWidgetAnswer(processes);
  if (online === false) return { kind: 'offline', ...(answer ? { heldAt: answer.capturedAtMs } : {}) };
  if (online === null) return { kind: 'live' };
  return answer && processes.status === 'error'
    ? { kind: 'stale', at: answer.capturedAtMs }
    : { kind: 'live' };
}

/**
 * The state that replaces a process widget's content when it has no answer to draw: the reserved rows,
 * an offline machine, an older Happier, a machine whose process reader is missing, or a failed read.
 * `null` means the body draws its answer.
 */
export function MachineProcessesWidgetGate(
  props: Readonly<{
    processes: MachineProcessesWidgetState;
    facts: MachineWidgetMachineFacts;
    rows: number;
    testID: string;
  }>,
): React.ReactElement | null {
  const { processes, facts } = props;
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (readMachineProcessesWidgetAnswer(processes)) return null;
  if (facts.online === false)
    return (
      <MachineWidgetState
        kind="offline"
        machineName={facts.name}
        lastSeenAt={facts.lastSeenAt}
        testID={props.testID}
      />
    );
  if (processes.status === 'not_supported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={facts.name}
        reason={t('machineProcesses.states.olderHappier', {
          machine: facts.name,
        })}
        testID={props.testID}
      />
    );
  if (
    processes.status === 'unavailable' ||
    processes.answer?.state === 'unavailable'
  )
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machineProcesses.states.errorTitle', { machine: facts.name })}
        reason={
          processes.answer?.reason === 'helper_missing'
            ? t('machineProcesses.states.helperMissing')
            : t('machineProcesses.states.errorBody')
        }
        testID={props.testID}
      />
    );
  if (processes.status === 'error')
    return (
      <MachineWidgetState
        kind="error"
        title={t('machineProcesses.states.errorTitle', { machine: facts.name })}
        reason={t('machineProcesses.states.errorBody')}
        onRetry={processes.retry}
        testID={props.testID}
      />
    );
  return (
    <MachineWidgetState
      kind="loading"
      rows={props.rows}
      testID={props.testID}
    />
  );
}

/** The one number a process widget is about ("9.9 GB", "4 processes"), with its line. */
export function MachineProcessesHero(
  props: Readonly<{
    label: string;
    value: string;
    unit: string;
    caption: string;
    quiet?: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  return (
    <View style={props.quiet ? styles.quiet : null}>
      <HappierDataMetric
        theme={pluginTheme}
        size="hero"
        label={props.label}
        value={props.value}
        unit={props.unit}
        caption={props.caption}
        testID={props.testID}
      />
    </View>
  );
}

/** A memory amount as a hero shows it: the figure and its unit apart ("9.9", "GB"). */
export function machineMemoryHeroParts(
  bytes: number | null,
): Readonly<{ value: string; unit: string }> {
  if (bytes === null) return { value: '—', unit: '' };
  const parts = machineBytesParts(bytes, 'memory');
  return { value: parts.value, unit: parts.unit };
}

/** A body's section label with its quiet fact at the right ("Still running on nl2 · Memory"). */
export function MachineWidgetSectionLabel(
  props: Readonly<{ title: string; meta?: string }>,
) {
  return (
    <View style={styles.label}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={styles.labelTitle}
      >
        {props.title}
      </Text>
      {props.meta ? (
        <Text numberOfLines={1} style={styles.labelMeta}>
          {props.meta}
        </Text>
      ) : null}
    </View>
  );
}

const keyOf = (item: ProcessesItem) => item.key;

/**
 * A row's share as the hairline beneath it: the row's rule filled in ink as far as its share of the total, from
 * the name's edge to the end (lab `rw` C). Through the one capacity bar, so a stop eases it down with the figure.
 */
function RowShareHairline(props: Readonly<{ share: number | null; testID: string }>) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const reducedMotion = useReducedMotionPreference();
  if (props.share === null) return null;
  return (
    <View pointerEvents="none" style={styles.shareHairline}>
      <CapacityBar
        testID={props.testID}
        theme={pluginTheme}
        label=""
        value={Math.min(1, Math.max(0, props.share))}
        capacity={1}
        color={theme.colors.text.tertiary}
        trackColor={theme.colors.border.subtle}
        height={SHARE_HAIRLINE_PX}
        showCaption={false}
        animated
        reducedMotion={reducedMotion}
      />
    </View>
  );
}

const SHARE_HAIRLINE_PX = 2;
/** Where a widget list row's name starts, measured live (focus ring, 22 px mark column, 12 px gap): the Collection's own row divider starts here. */
const ROW_NAME_EDGE_PX = 35;

/**
 * The Processes tab's rows (plan 30's anatomy, read-only: the tab's menus are not offered here), as a list
 * where the widget is narrow and the tab's table where it is wide. `accessory` adds a row's one inline
 * action (Stop); a row press opens the Processes tab.
 */
export function MachineProcessesWidgetRows(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    items: readonly ProcessesItem[];
    titles: ReadonlyMap<string, string>;
    cpuCapacityCores: number | null;
    table: boolean;
    /** A narrow list of one-line rows: name, status inline, memory at the end (lab `rw` C). */
    singleLine?: boolean;
    accessibilityLabel: string;
    onOpen: () => void;
    accessory?: (item: ProcessesItem) => React.ReactNode;
    /** Rows letting go after a stop (the tab's stop-and-ease). */
    leaving?: ReadonlySet<string>;
    /**
     * A row's share of the widget's own total (0..1), drawn as a hairline under the row so the list reads as a chart
     * (lab `rw` C); `null` draws none. Narrow list only: the table says its figures in columns.
     */
    shareOf?: (item: ProcessesItem) => number | null;
    summaryRows?: readonly CollectionSummaryRow[];
    testID: string;
  }>,
) {
  const { onOpen, accessory, leaving, shareOf } = props;
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      if (key) onOpen();
    },
    [onOpen],
  );
  const model = useHappierCollection<ProcessesItem>({
    items: props.items,
    keyOf,
    openKey: null,
    onOpenChange,
    expandable: false,
  });
  const anatomyInput = React.useMemo(
    () => ({
      serverId: props.serverId,
      machineId: props.machineId,
      machineName: props.machineName,
      titles: props.titles,
      cpuCapacityCores: props.cpuCapacityCores,
      compact: !props.table,
      // A narrow widget list says the figure on the name's own line (lab `rw` C, LB).
      memoryOnTitleLine: !props.table,
      singleLine: !props.table && props.singleLine === true,
      readOnly: true,
    }),
    [
      props.singleLine,
      props.cpuCapacityCores,
      props.machineId,
      props.machineName,
      props.serverId,
      props.table,
      props.titles,
    ],
  );
  const base = useProcessesCollectionAnatomy(anatomyInput);
  const anatomy = React.useMemo(
    (): CollectionAnatomy<ProcessesItem> =>
      accessory || leaving || shareOf
        ? {
            ...base,
            wrapItem: (item, content) => (
              <ProcessRowPresence leaving={leaving?.has(item.key) ?? false}>
                <View style={styles.row}>
                  <View style={styles.rowContent}>
                    {content}
                    {shareOf ? <RowShareHairline share={shareOf(item)} testID={`machine-processes-share-${item.key}`} /> : null}
                  </View>
                  {accessory?.(item)}
                </View>
              </ProcessRowPresence>
            ),
          }
        : base,
    [accessory, base, leaving, shareOf],
  );
  return (
    <CoreCollectionScope>
      <Collection<ProcessesItem>
        testID={props.testID}
        model={model}
        anatomy={anatomy}
        accessibilityLabel={props.accessibilityLabel}
        presentation={props.table ? 'table' : 'list'}
        detail="none"
        scroll="page"
        minListWidth={0}
        minDetailWidth={0}
        preferredListRatio={1}
        {...(props.summaryRows ? { summaryRows: props.summaryRows } : {})}
      />
    </CoreCollectionScope>
  );
}

const styles = StyleSheet.create((theme) => ({
  quiet: {
    opacity: 0.55,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
  },
  labelTitle: {
    ...Typography.variant('meta'),
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  labelMeta: {
    ...Typography.variant('meta'),
    marginLeft: 'auto',
    color: theme.colors.text.tertiary,
  },
  // The hairline lies on the row's own rule: from the name's edge (after the mark) to the row's end.
  shareHairline: {
    position: 'absolute',
    left: ROW_NAME_EDGE_PX,
    right: 0,
    bottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
}));
