import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { doesHappierCapabilityStatusSpeak, HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_ROW_STYLE, isHappierPageRowNarrow } from '@happier-dev/plugin-ui/presentation';

import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { presentCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { metaFigureStyle } from '@/components/ui/text/metaFigures';
import { useDeviceType } from '@/utils/platform/responsive';
import { buildCapabilityCollectionAnatomy } from './buildCapabilityCollectionAnatomy';

export type CapabilityRowProps = Readonly<{
  title: string;
  description?: string | null;
  /** The where-summary from `shortWhereItsOn` (or a session scope word); never truncated (R1). */
  whereSummary?: React.ReactNode;
  /** A quiet qualifier right after the name on the title line (a legend's "uvx · Everywhere"), in place of the end-aligned where-summary. */
  qualifier?: string;
  facts?: CapabilityFactsProps;
  /** A speaking status leads the description and supplies its independent fix. */
  status?: CapabilityStatus | null;
  /**
   * A quiet fact that leads line 2 when no status speaks, because the person must see it before relying on the
   * row (a skill's "Runs scripts"); other facts stay in the detail.
   */
  lead?: string | null;
  /** Identity mark (MCP server mark, agent mark). Skills have none. */
  mark?: React.ReactNode;
  /**
   * A checklist row (first run's "Choose what your agents get"): a leading checkbox in the mark's column, and
   * the whole row is the checkbox (its press toggles it).
   */
  checked?: boolean;
  /** Right action column (Add, Install, "In your library ✓"; on scope pages only, a `Switch`). */
  action?: React.ReactNode;
  /** A quiet count at the end of the title line (an MCP server's tools). */
  count?: number | null;
  /** A quiet explanation under the facts, on the row's text edge (Found: "this copy wins on <machine>"). */
  note?: React.ReactNode;
  /** A wide action leaves its column on a narrow row (a phone) and sits under the text instead. */
  stackActionWhenNarrow?: boolean;
  /**
   * `item` for a genuinely title-only collection (a map's legend, a key): compact rows instead of the catalog floor
   * (S10 §5.2). Described collections, and their peers missing a description, keep `catalogRow`.
   */
  rowRole?: 'catalogRow' | 'item';
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

const EMPTY_FACTS = {};
/**
 * Line 2's separator: the word joiner glues the dot to the word before it, so a wrapped line starts with the next
 * fact and never with a stray "·". Unlike a no-break space it adds no width and leaves the words' own breaks alone.
 */
const QUIET_DOT = ' \u2060· ';
// Built on first render, not at module load: this module sits in an import cycle with the anatomy owner
// (via SessionCapabilitiesContent), and a load-time call reads that owner's parts before they exist.
let rowAnatomy: ReturnType<typeof buildRowAnatomy> | null = null;
const getRowAnatomy = () => (rowAnatomy ??= buildRowAnatomy());
const buildRowAnatomy = () => buildCapabilityCollectionAnatomy<CapabilityRowProps>({
  title: (row) => row.title,
  description: (row) => row.description ?? null,
  whereSummary: (row) => row.whereSummary === t('capabilities.where.everywhere') || row.whereSummary === t('capabilities.where.off')
    ? null : row.whereSummary,
  count: (row) => row.count,
  facts: (row) => row.facts ?? EMPTY_FACTS,
  status: (row) => row.status ?? null,
  mark: (row) => row.mark,
  action: (row) => row.action,
  accessibilityLabel: (row) => {
    const status = row.status ? presentCapabilityStatus(row.status) : null;
    return [row.title, row.qualifier, row.description, typeof row.whereSummary === 'string' ? row.whereSummary : null,
      row.count, status?.pill?.label, status?.reason].filter((part) => part !== undefined && part !== null && part !== '').join('. ');
  },
  testID: (row) => row.testID,
});

/**
 * One capability row for every capability list (rails, homepages, Found, machine page, composer): the name never
 * squeezed, held count/scope on the title line, and the canonical status leading the description. Menu density
 * keeps scope/checklist semantics; fixes and independent actions always sit outside the row's activation.
 */
export const CapabilityRow = React.memo(function CapabilityRow(
  props: CapabilityRowProps,
) {
  const anatomy = getRowAnatomy();
  const density = props.density ?? 'page';
  const menu = density === 'menu';
  // A page row on a phone has the width for two description lines (lab phone rows); everywhere else one keeps the list dense.
  const onPhone = useDeviceType() === 'phone';
  const descriptionLines = density !== 'menu' && onPhone ? 2 : 1;
  // Menu density recomposes on a narrow row (a phone sheet): the scope leaves its column for line 3, and
  // a wide action (`stackActionWhenNarrow`) leaves its column for the line under the text.
  const [narrow, setNarrow] = React.useState(false);
  // ST-5 at large text: a status word and its fix share the row while the word fits whole beside the fix; when it
  // cannot, the fix moves beneath the text. The measured word and the room the row leaves it decide (no width cutoff):
  // `slack` is what the row spends beside the text column (mark, insets, the fix), read while the fix is inline.
  const [fixBeneath, setFixBeneath] = React.useState(false);
  const fixMeasure = React.useRef({ row: 0, column: 0, word: 0, slack: null as number | null, beneath: false });
  const placeFix = React.useCallback((next: Partial<{ row: number; column: number; word: number }>) => {
    const measured = fixMeasure.current;
    Object.assign(measured, next);
    if (!measured.beneath && measured.row > 0 && measured.column > 0) measured.slack = measured.row - measured.column;
    if (measured.slack === null || measured.word <= 0) return;
    const beneath = measured.word > measured.row - measured.slack + 0.5;
    if (beneath === measured.beneath) return;
    measured.beneath = beneath;
    setFixBeneath(beneath);
  }, []);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const widthPx = event.nativeEvent.layout.width;
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    setNarrow(isHappierPageRowNarrow(widthPx));
    placeFix({ row: widthPx });
  }, [placeFix]);
  const status =
    props.status != null &&
    doesHappierCapabilityStatusSpeak(props.status, 'row')
      ? props.status
      : null;
  // A scope that is not known yet (an empty string) leaves no summary, and no separator beside it.
  const summary =
    !menu || props.whereSummary == null || props.whereSummary === '' ? null : typeof props.whereSummary ===
      'string' ? (
      <Text variant="meta" numberOfLines={1} style={[styles.summary, metaFigureStyle(props.whereSummary)]}>
        {props.whereSummary}
      </Text>
    ) : (
      props.whereSummary
    );
  const statusLine = status === null ? null : menu
    ? <CapabilityStatusChip status={status} testID={`${props.testID}:status`} />
    : anatomy.reason?.(props) ?? null;
  // Catalog admission keeps quiet facts for cards/detail; only menus admit the legacy facts line.
  // Counts already belong to titleMeta, while safety leads and unavailable-read notes retain their own slots.
  const factsLine = statusLine ?? (!menu || props.facts === undefined ? null : anatomy.byline?.(props) ?? null);
  // A menu caller owns its composed scope controls (fix + remove); catalog rows use the shared action projection.
  const action = menu ? props.action ?? null : anatomy.action?.(props) ?? null;
  // Line 2 is one text run: the speaking status word, then the quiet lead (a consequence such as "Runs scripts", which a
  // status never hides), then the description, so they wrap and ellipsize together and the description yields first
  // (lab y:list "Needs sign-in · Find, cre…"). On a narrow row a fix replaces the description (ST-5). A status with a
  // reason keeps the chip, whose reason wraps whole under it, and the lead then leads the description line.
  const word = menu || status === null ? null : presentCapabilityStatus(status, 'catalog');
  const inlineStatus = word?.pill != null && word.reason === undefined ? word.pill : null;
  const lineDescription = anatomy.description?.(props, { narrow }) ?? null;
  // The word-and-fix pair this row measures: a speaking status word whose fix is drawn at the row's end.
  const fixPair = !menu && inlineStatus !== null && status?.fix != null && action !== null;
  const lead = props.lead ? props.lead : null;
  const catalogLine = menu || !(inlineStatus !== null || (lead !== null && statusLine === null)) ? null : (
    // A status word that stands alone (its fix took the description's place) wraps rather than ellipsizing (ST-5).
    <Text variant="body" numberOfLines={lineDescription ? descriptionLines : 2} style={styles.line}>
      {inlineStatus !== null
        ? <StatusWord variant={inlineStatus.variant} label={inlineStatus.label} testID={`${props.testID}:status`} />
        : null}
      {lead === null ? null : <Text style={styles.lead}>{inlineStatus !== null ? `${QUIET_DOT}${lead}` : lead}</Text>}
      {lineDescription ? `${QUIET_DOT}${lineDescription}` : null}
    </Text>
  );
  const catalogSubtitle = menu ? null : catalogLine !== null ? (fixPair && inlineStatus !== null ? (
    // The pair's measures: the text column this line fills, and the status word's own width, out of flow.
    <View onLayout={(event: LayoutChangeEvent) => { placeFix({ column: event.nativeEvent.layout.width }); }}>
      {catalogLine}
      <Text variant="body" numberOfLines={1} style={[styles.line, styles.measure]} aria-hidden
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`${props.testID}:status:measure`}
        onLayout={(event: LayoutChangeEvent) => { placeFix({ word: event.nativeEvent.layout.width }); }}>
        {inlineStatus.label}
      </Text>
    </View>
  ) : catalogLine) : statusLine === null ? props.description : (
    <View style={styles.narrowFactsLine}>
      {statusLine}
      {lead !== null || lineDescription ? (
        <Text variant="body" numberOfLines={descriptionLines} style={styles.line}>
          {lead === null ? null : <Text style={styles.lead}>{lead}</Text>}
          {lineDescription ? `${lead === null ? '' : ' · '}${lineDescription}` : null}
        </Text>
      ) : null}
    </View>
  );
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
    !menu && action !== null && ((props.stackActionWhenNarrow === true && narrow) || (fixPair && fixBeneath))
      ? action
      : null;
  const bottom =
    menu || ((statusLine !== null || factsLine === null) && props.note == null && stackedAction === null) ? null : (
      <>
        {statusLine === null ? factsLine : null}
        {props.note == null ? null : <View style={styles.note}>{props.note}</View>}
        {stackedAction === null ? null : <View style={styles.stackedAction}>{stackedAction}</View>}
      </>
    );
  const right = stackedAction !== null ? null : menuNarrow ? (
    action === null ? null : <View style={styles.narrowAction}>{action}</View>
  ) : menu ? (
    summary === null && action === null ? null : (
      <View style={styles.menuColumns}>
        {summary === null ? null : (
          <View style={[styles.scope, dimmed ? styles.dimmed : null]} testID={`${props.testID}:scope`}>
            {summary}
          </View>
        )}
        {action === null ? null : (
          <View style={styles.menuAction}>{action}</View>
        )}
      </View>
    )
  ) : (
    action
  );
  return (
    <View onLayout={onLayout}>
      <Item
        title={anatomy.title(props)}
        accessibilityLabel={anatomy.accessibilityLabel(props)}
        {...(menu ? {} : { titleLines: 0 })}
        {...(menu
          ? menuSubtitle == null ? {} : { subtitle: menuSubtitle }
          : catalogSubtitle == null ? {} : { subtitle: catalogSubtitle })}
        subtitleLines={descriptionLines}
        {...(menu ? {} : { titleMeta: anatomy.titleMeta?.(props) })}
        {...(props.qualifier === undefined ? {} : { titleQualifier: props.qualifier })}
        {...(props.checked !== undefined
          ? {
              icon: <SelectionCheckGlyph state={props.checked ? 'checked' : 'unchecked'} />,
              accessibilityRole: 'checkbox' as const,
              accessibilityChecked: props.checked,
            }
          : props.mark == null ? {} : { icon: dimmed ? <View style={styles.dimmed}>{anatomy.glyph(props)}</View> : anatomy.glyph(props) })}
        {...(dimmed ? { titleStyle: styles.dimmed, subtitleStyle: styles.dimmed } : {})}
        {...(right === null ? {} : { rightElement: right, ...(action === null ? {} : { rightElementOutsidePressable: true }) })}
        {...(bottom === null
          ? {}
          : {
              bottomElement: <View style={styles.facts}>{bottom}</View>,
              bottomElementInset: 'text' as const,
              ...(stackedAction !== null || props.note != null ? { bottomElementOutsidePressable: true } : {}),
            })}
        // Facts sit right under the description: the row's own bottom padding moves below them.
        {...(bottom !== null ? { style: styles.factsFollow } : {})}
        {...(props.selected === undefined ? {} : { selected: props.selected })}
        // A column's rows share the list's one rounded inset plane for hover and selection (Agents, Providers, the rail).
        {...(density === 'rail' ? { pressableStyle: HAPPIER_COLLECTION_LIST_ROW_STYLE } : {})}
        {...(props.onPreviewChange === undefined
          ? {}
          : {
              onHoverIn: () => props.onPreviewChange?.(true),
              onHoverOut: () => props.onPreviewChange?.(false),
              onFocus: () => props.onPreviewChange?.(true),
              onBlur: () => props.onPreviewChange?.(false),
            })}
        rowRole={menu ? 'menu' : props.rowRole ?? anatomy.rowRole}
        {...(menu ? {} : { density: 'compact' as const })}
        {...(props.onPress === undefined ? {} : { onPress: props.onPress })}
        showChevron={false}
        showDivider={menu && props.divider !== false}
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
  /** A catalog row's line 2 is words (status, description): proportional figures, so "sign-in" keeps its hyphen tight. */
  line: { color: theme.colors.text.secondary },
  facts: { paddingTop: theme.space.s2, minWidth: 0 },
  factsFollow: { paddingBottom: 0 },
  note: { paddingTop: theme.space.s8, minWidth: 0 },
  stackedAction: { paddingTop: theme.space.s8, alignItems: 'flex-start' },
  /** Out of flow and invisible: measures the status word's natural width (Item's own measuring pattern). */
  measure: { position: 'absolute', left: 0, top: 0, opacity: 0, pointerEvents: 'none' },
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
  lead: { color: theme.colors.text.tertiary },
  dimmed: { opacity: HAPPIER_COLLECTION_LIST_METRICS.dimmedOpacity },
}));
