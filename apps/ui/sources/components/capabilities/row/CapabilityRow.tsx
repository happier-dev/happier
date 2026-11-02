import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { doesHappierCapabilityStatusSpeak, isHappierPageRowNarrow } from '@happier-dev/plugin-ui/presentation';

import {
  CapabilityFacts,
  type CapabilityFactsProps,
} from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { Item } from '@/components/ui/lists/Item';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { metaFigureStyle } from '@/components/ui/text/metaFigures';
import { useDeviceType } from '@/utils/platform/responsive';

export type CapabilityRowProps = Readonly<{
  title: string;
  description?: string | null;
  /** The where-summary from `shortWhereItsOn` (or a session scope word); never truncated (R1). */
  whereSummary?: React.ReactNode;
  /** A quiet qualifier right after the name on the title line (a legend's "uvx · Everywhere"), in place of the end-aligned where-summary. */
  qualifier?: string;
  facts?: CapabilityFactsProps;
  /** When present and not silent, replaces the facts line (status takes the facts line). */
  status?: CapabilityStatus | null;
  /** Identity mark (MCP server mark, agent mark). Skills have none. */
  mark?: React.ReactNode;
  /**
   * A checklist row (first run's "Choose what your agents get"): a leading checkbox in the mark's column, and
   * the whole row is the checkbox (its press toggles it).
   */
  checked?: boolean;
  /** Right action column (Add, Install, "In your library ✓"; on scope pages only, a `Switch`). */
  action?: React.ReactNode;
  /** A quiet explanation under the facts, on the row's text edge (Found: "this copy wins on <machine>"). */
  note?: React.ReactNode;
  /** A wide action leaves its column on a narrow row (a phone) and sits under the text instead. */
  stackActionWhenNarrow?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  density?: 'page' | 'rail' | 'menu';
  onPress?: () => void;
  /** A legend's rows stand without hairlines between them (a homepage map's legend); rows in a list keep them. */
  divider?: false;
  /** Pointer over or keyboard focus on the row (a homepage map previews its reach); false when it leaves. */
  onPreviewChange?: (active: boolean) => void;
  testID: string;
}>;

/**
 * One capability row for every capability list (rails, homepages, Found, machine page, composer): the name never
 * squeezed, the where-summary at the title line's end and never truncated, the description truncating first, and
 * the facts line, which a non-silent status takes. Menu density draws the scope as its own fixed column before the
 * action instead of on the title line.
 */
export const CapabilityRow = React.memo(function CapabilityRow(
  props: CapabilityRowProps,
) {
  const density = props.density ?? 'page';
  // A page row on a phone has the width for two description lines (lab phone rows); everywhere else one keeps the list dense.
  const onPhone = useDeviceType() === 'phone';
  const descriptionLines = density === 'page' && onPhone ? 2 : 1;
  // Menu density recomposes on a narrow row (a phone sheet): the scope leaves its column for line 3, and
  // a wide action (`stackActionWhenNarrow`) leaves its column for the line under the text.
  const [narrow, setNarrow] = React.useState(false);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setNarrow(isHappierPageRowNarrow(event.nativeEvent.layout.width));
  }, []);
  const status =
    props.status != null &&
    doesHappierCapabilityStatusSpeak(props.status, 'row')
      ? props.status
      : null;
  const summary =
    props.whereSummary == null ? null : typeof props.whereSummary ===
      'string' ? (
      <Text variant="meta" numberOfLines={1} style={[styles.summary, metaFigureStyle(props.whereSummary)]}>
        {props.whereSummary}
      </Text>
    ) : (
      props.whereSummary
    );
  const factsLine =
    status !== null ? (
      <CapabilityStatusChip status={status} testID={`${props.testID}:status`} />
    ) : props.facts === undefined ? null : (
      <CapabilityFacts {...props.facts} />
    );
  const menu = density === 'menu';
  // A dimmed row (off for this session) fades what it is, never its action: "Turn on" stays at full ink.
  const dimmed = props.dimmed === true;
  const menuNarrow = menu && narrow;
  // Menu density has one line 2 under the name, at the subtitle's own rhythm: a speaking status, else the
  // description (a session change), else the facts. On a narrow row the scope follows it as line 3.
  const menuLine2: React.ReactNode =
    status !== null || props.description == null ? factsLine : props.description;
  // Plain facts share the scope's line ("Everywhere · 1.2k tokens"); a status or a change is its own line 2.
  const narrowScopeLeadsFacts = status === null && props.description == null && factsLine !== null;
  const menuSubtitle: React.ReactNode =
    menuNarrow && summary !== null ? (
      narrowScopeLeadsFacts ? (
        <View style={[styles.narrowFactsLine, dimmed ? styles.dimmed : null]}>
          <View testID={`${props.testID}:scope`}>{summary}</View>
          <Text variant="meta" style={styles.dot} aria-hidden>·</Text>
          {factsLine}
        </View>
      ) : (
        <View style={[styles.narrowLines, dimmed ? styles.dimmed : null]}>
          {typeof menuLine2 === 'string' ? (
            <Text variant="meta" numberOfLines={1} style={[styles.summary, metaFigureStyle(menuLine2)]}>{menuLine2}</Text>
          ) : menuLine2}
          <View testID={`${props.testID}:scope`}>{summary}</View>
        </View>
      )
    ) : (
      menuLine2
    );
  const stackedAction =
    props.stackActionWhenNarrow === true &&
    narrow &&
    !menu &&
    props.action != null
      ? props.action
      : null;
  const bottom =
    menu || (factsLine === null && props.note == null && stackedAction === null) ? null : (
      <>
        {factsLine}
        {props.note == null ? null : <View style={styles.note}>{props.note}</View>}
        {stackedAction === null ? null : <View style={styles.stackedAction}>{stackedAction}</View>}
      </>
    );
  const right = stackedAction !== null ? null : menuNarrow ? (
    props.action == null ? null : <View style={styles.narrowAction}>{props.action}</View>
  ) : menu ? (
    summary === null && props.action == null ? null : (
      <View style={styles.menuColumns}>
        {summary === null ? null : (
          <View style={[styles.scope, dimmed ? styles.dimmed : null]} testID={`${props.testID}:scope`}>
            {summary}
          </View>
        )}
        {props.action == null ? null : (
          <View style={styles.menuAction}>{props.action}</View>
        )}
      </View>
    )
  ) : (
    (props.action ?? null)
  );
  return (
    <View {...(menu || props.stackActionWhenNarrow === true ? { onLayout } : {})}>
      <Item
        title={props.title}
        {...(menu
          ? menuSubtitle == null ? {} : { subtitle: menuSubtitle }
          : props.description == null ? {} : { subtitle: props.description })}
        subtitleLines={descriptionLines}
        {...(menu || summary === null ? {} : { titleMeta: summary })}
        {...(props.qualifier === undefined ? {} : { titleQualifier: props.qualifier })}
        {...(props.checked !== undefined
          ? {
              icon: <SelectionCheckGlyph state={props.checked ? 'checked' : 'unchecked'} />,
              accessibilityRole: 'checkbox' as const,
              accessibilityChecked: props.checked,
            }
          : props.mark == null ? {} : { icon: dimmed ? <View style={styles.dimmed}>{props.mark}</View> : props.mark })}
        {...(dimmed ? { titleStyle: styles.dimmed, subtitleStyle: styles.dimmed } : {})}
        {...(right === null ? {} : { rightElement: right })}
        {...(bottom === null
          ? {}
          : {
              bottomElement: <View style={density === 'page' ? styles.factsPage : styles.facts}>{bottom}</View>,
              bottomElementInset: 'text' as const,
            })}
        // Facts sit right under the description: the row's own bottom padding moves below them.
        {...(bottom !== null && density === 'page' ? { style: styles.factsFollow } : {})}
        {...(props.selected === undefined ? {} : { selected: props.selected })}
        {...(density === 'rail'
          ? { density: 'compact' as const, pressableStyle: collectionListStyles.row }
          : {})}
        {...(props.onPreviewChange === undefined
          ? {}
          : {
              onHoverIn: () => props.onPreviewChange?.(true),
              onHoverOut: () => props.onPreviewChange?.(false),
              onFocus: () => props.onPreviewChange?.(true),
              onBlur: () => props.onPreviewChange?.(false),
            })}
        {...(menu ? { rowRole: 'menu' as const } : {})}
        {...(props.onPress === undefined ? {} : { onPress: props.onPress })}
        showChevron={false}
        {...(props.divider === false ? { showDivider: false } : {})}
        testID={props.testID}
      />
    </View>
  );
});

/** Menu-density columns: the scope words ("In client-site", "Everywhere") and the action (fix + x, or Turn on). */
const MENU_SCOPE_COLUMN_PX = 112;
const MENU_ACTION_COLUMN_PX = 120;

const styles = StyleSheet.create((theme) => ({
  summary: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  facts: { paddingTop: theme.space.s2, minWidth: 0 },
  factsFollow: { paddingBottom: 0 },
  factsPage: { paddingTop: theme.space.s4, minWidth: 0 },
  note: { paddingTop: theme.space.s8, minWidth: 0 },
  stackedAction: { paddingTop: theme.space.s8, alignItems: 'flex-start' },
  menuColumns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  // Menu density is one grid for every row of a menu (IR-81): the scope starts at the same x on each
  // row and the action column keeps one width, so a row with a fix and a row with × align. Both are
  // minimums: a longer scope or a longer translated fix grows its row instead of truncating.
  scope: { flexShrink: 0, minWidth: MENU_SCOPE_COLUMN_PX, alignItems: 'flex-start' },
  menuAction: {
    minWidth: MENU_ACTION_COLUMN_PX,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
  // Stretch, so a long status chip truncates inside the row instead of running past it.
  narrowLines: { gap: theme.space.s2, alignItems: 'stretch', minWidth: 0 },
  narrowAction: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  narrowFactsLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minWidth: 0 },
  dot: { color: theme.colors.text.tertiary },
  dimmed: { opacity: 0.6 },
}));
