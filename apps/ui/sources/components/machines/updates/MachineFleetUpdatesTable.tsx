import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  Status,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui';

import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import type { FleetUpdatesRow } from './machineFleetUpdates';

const s = 'machineFleetUpdates' as const;
/** The table's narrowest readable width: the Machine and its three facts. */
const LIST_MIN_WIDTH_PX = 320;
const COUNT_COLUMN_WIDTH_PX = 88;
const RESTART_COLUMN_WIDTH_PX = 160;
/** Holds the as-of time in its longest form ("26 Sep, 18:44"), or "As of" before it. */
const CHECKED_COLUMN_WIDTH_PX = 136;

const keyOfRow = (row: FleetUpdatesRow) => row.machineId;

/** What the row knows: its pushed facts, or that it can't say today (offline, not checked yet). */
function known(row: FleetUpdatesRow): boolean {
  return row.online === true && (row.security !== null || row.all !== null);
}

/** The phone's byline: the Machine's system, then the same facts as the table's columns, in one line. */
function describeFacts(row: FleetUpdatesRow): string {
  if (row.online === false) return t(`${s}.offline`);
  if (!known(row)) return t(`${s}.notChecked`);
  return [
    row.security === null ? null : t(`${s}.security`, { count: row.security }),
    row.all === null ? null : t(`${s}.all`, { count: row.all }),
    row.restartNeeded ? t(`${s}.restartNeeded`) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Machines → Updates as a table (pfc-redesign fUpd): the Machine with its system, then Security, All and Restart from
 * the facts it pushes. A count that needs you (security, a restart) carries the amber dot; what a Machine can't say
 * today reads "—", never zero. A phone keeps the Machine and says its facts beneath it. Rows open the Machine's
 * Security tab. The page owns the Collection scope and column it stands in.
 */
export function MachineFleetUpdatesTable(
  props: Readonly<{
    rows: readonly FleetUpdatesRow[];
    onOpen: (machineId: string) => void;
    testID: string;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const onOpenChange = props.onOpen;
  const open = React.useCallback(
    (key: string | null) => {
      if (key) onOpenChange(key);
    },
    [onOpenChange],
  );
  const model = useHappierCollection<FleetUpdatesRow>({
    items: props.rows,
    keyOf: keyOfRow,
    selection: 'none',
    openKey: null,
    onOpenChange: open,
  });
  const anatomy = React.useMemo((): CollectionAnatomy<FleetUpdatesRow> => {
    const fields: CollectionField<FleetUpdatesRow>[] = [
      {
        key: 'security',
        title: t(`${s}.columnSecurity`),
        minWidth: COUNT_COLUMN_WIDTH_PX,
        priority: 3,
        align: 'end',
        render: (row) => (
          <CountCell value={known(row) ? row.security : null} attention />
        ),
      },
      {
        key: 'all',
        title: t(`${s}.columnAll`),
        minWidth: COUNT_COLUMN_WIDTH_PX,
        priority: 2,
        align: 'end',
        render: (row) => <CountCell value={known(row) ? row.all : null} />,
      },
      {
        key: 'restart',
        title: t(`${s}.columnRestart`),
        minWidth: RESTART_COLUMN_WIDTH_PX,
        priority: 1,
        render: (row) => <RestartCell row={row} />,
      },
      {
        key: 'checked',
        title: t(`${s}.columnChecked`),
        minWidth: CHECKED_COLUMN_WIDTH_PX,
        priority: 0,
        align: 'end',
        render: (row) => <CheckedCell row={row} />,
      },
    ];
    return {
      glyph: (row) => (
        <Icon
          name={resolveMachineKindGlyph({
            isThisComputer: false,
            platform: row.platform,
          })}
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      ),
      title: (row) => row.name,
      // What the Machine runs beside its name, as the Machines table says its facts (lab fUpd: \"Ubuntu 24.04\").
      titleSuffix: (row) => (phone ? null : formatOSPlatform(row.platform) || null),
      // The list's second line (where the table recomposes on a phone, lab fUpd · 390): the system and the same facts
      // as the columns; the table draws its columns instead. A phone keeps the check time at the row's end.
      byline: (row) => [formatOSPlatform(row.platform), describeFacts(row)].filter(Boolean).join(' · '),
      ...(phone ? { titleMeta: (row: FleetUpdatesRow) => <CheckedCell row={row} /> } : {}),
      fields,
      accessibilityLabel: (row) =>
        [row.name, formatOSPlatform(row.platform), describeFacts(row)]
          .filter(Boolean)
          .join(', '),
      testID: (row) => `machines.updates.row.${row.machineId}`,
      columnTitles: { title: t('allMachines.columnMachine') },
    };
  }, [language, phone, theme.colors.text.secondary]);
  return (
      <Collection<FleetUpdatesRow>
        testID={props.testID}
        model={model}
        anatomy={anatomy}
        accessibilityLabel={t(`${s}.title`)}
        // Where no column fits beside the Machine (a phone), the table recomposes into its list (as the Machines index).
        presentation="table"
        detail="none"
        // A fleet is user-sized data: the table windows its rows in the page.
        scroll="page-virtualized"
        minListWidth={LIST_MIN_WIDTH_PX}
        minDetailWidth={0}
        preferredListRatio={1}
      />
  );
}

/** A count in tabular figures; a security count that waits carries the amber dot; unknown is "—". */
function CountCell(
  props: Readonly<{ value: number | null; attention?: boolean }>,
) {
  if (props.value === null) return <Text style={styles.quiet}>—</Text>;
  return props.attention === true && props.value > 0 ? (
    <Status tone="warning" label={String(props.value)} presentation="inline" />
  ) : (
    <Text numberOfLines={1} style={styles.count}>
      {String(props.value)}
    </Text>
  );
}

/**
 * When the Machine last checked (lab fUpd Checked): the time it reported; an offline Machine's is its last one
 * ("As of 14:02"); never checked reads "—".
 */
function CheckedCell(props: Readonly<{ row: FleetUpdatesRow }>) {
  const { checkedAt, online } = props.row;
  if (checkedAt === null) return <Text style={styles.quiet}>—</Text>;
  const time = formatAsOfTime(checkedAt);
  return (
    <Text numberOfLines={1} style={online === true ? styles.count : styles.quiet}>
      {online === true ? time : t(`${s}.checkedAsOf`, { time })}
    </Text>
  );
}

function RestartCell(props: Readonly<{ row: FleetUpdatesRow }>) {
  if (!known(props.row)) return <Text style={styles.quiet}>—</Text>;
  return props.row.restartNeeded ? (
    <Status tone="warning" label={t(`${s}.restartNeeded`)} presentation="inline" />
  ) : (
    <Text numberOfLines={1} style={styles.quiet}>
      {t(`${s}.restartNotNeeded`)}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  count: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.primary,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
