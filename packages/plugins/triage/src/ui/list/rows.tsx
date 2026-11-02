import * as React from 'react';
import {
  Badge,
  BrandMark,
  Button,
  DragSource,
  DropTarget,
  HAPPIER_WORK_STATUS_SEMANTIC_TONE,
  Icon,
  isHappierIconName,
  resolveHappierIconSize,
  Row,
  Stack,
  Status,
  TaskStatusGlyph,
  Text,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
  type CollectionAnatomy,
  type CollectionRowActions,
  type IconName,
  type ListItemProps,
  type PluginTranslate,
  type TextTone,
} from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1, resolveTriageRowFactStatusToneV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageEntryRelationsV1, TriageSourceDescriptorV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageSourceDescriptorV1, resolveTriageSourceDescriptorV1, resolveTriageSourceWorkflowSubjectV1 } from '../detail/sourceSurface.js';
import {
  readTriageEntryRowAnnouncementV1,
  readTriageEntryRowContextV1,
  readTriageEntryGlyphV1,
  type TriageEntryDisplayTextV1,
} from '../window/entryDisplay.js';
import type { TriageListGroupIdV1, TriageListItemV1, TriageListRowSignalV1, TriageListTaskFactsV1 } from './sections.js';
import { TriageTaskRowStatusControl } from '../detail/taskFields.js';
import { createTriageTaskListFactV1, readTriageTaskDueV1 } from './taskColumns.js';
export { readTriageTaskDueV1 } from './taskColumns.js';

const NO_SHARED_GROUP_REASONS: ReadonlyMap<TriageListGroupIdV1, string> = new Map();
const NO_TASK_REREAD = async () => undefined;
import type { TriageAgentStatusV1 } from '../detail/agentState.js';
import { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1, TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1 } from './entryDragDrop.js';
import { isInternalTaskReferenceV1 } from '../../internalTasks/identity.js';
import type { PersonalTaskOrder } from './usePersonalTaskOrder.js';

/**
 * One PRs & Issues row.
 *
 * The row is the shared Collection's (`@happier-dev/plugin-ui` `Collection`, presenting through the one `List`
 * engine): activation, selection semantics, keyboard behavior, focus registration, target size, the table and list
 * geometries and the peek are all owned there (`core/SURFACE.md` §1.2, COLLECTION.md §3). The only things this
 * file decides are which already-projected words go in which anatomy slot, and which single Pin/Unpin affordance
 * the row carries.
 *
 * There is exactly one such affordance per row, and it is never two states of two controls. Every row offers it
 * through the public secondary-action owner, which keeps the overflow outside the row press target and owns the
 * menu's focus and keyboard behavior. That includes a pinned row this mount never materialized: it has no detail
 * panel to host the operation, so its row menu is where the reader removes the pin (an inline Unpin beside the
 * shared row menu read as a stray word in the Age column and squeezed the place on a phone).
 */

export type TriageRowPinHandlersV1 = Readonly<{
  /** The row whose Pin/Unpin write has not settled yet, by list key. */
  busyKey: string | null;
  /**
   * Why Pin/Unpin cannot be offered right now, in words. Non-null disables the
   * affordance and is said out loud rather than shown as an inert control.
   */
  unavailableReason: string | null;
  onSetPinned: (row: TriageListDisplayRowV1) => void;
}>;

const PIN_ACTION_ID = 'set-pinned';

type TriagePinActionTextV1 = (
  key: string,
  fallback?: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

/** One label owner for the row overflow and the selected-entry header. */
export function readTriagePinActionLabelV1(
  row: Pick<TriageListDisplayRowV1, 'pinned' | 'title'>,
  text: TriagePinActionTextV1,
): string {
  return row.pinned
    ? text('plugins.triage.surface.row.unpin', 'Unpin {title}', { title: row.title })
    : text('plugins.triage.surface.row.pin', 'Pin {title}', { title: row.title });
}

/**
 * The row's secondary actions. Select is not among them: the shared `List` owns the row menu's Select/Deselect
 * (the only way a finger builds a bulk set) for every Collection, so a second Triage copy would list it twice.
 * The menu already names its row ("More actions for {title}"), so each item is a short verb.
 */
export function triageListRowSecondaryActionsV1(input: Readonly<{
  pinLabel: string;
  pinDisabled: boolean;
}>): readonly Readonly<{ id: string; label: string; disabled?: boolean }>[] {
  return [{ id: PIN_ACTION_ID, label: input.pinLabel, disabled: input.pinDisabled }];
}

/**
 * How many lines a row's own text may occupy.
 *
 * These are not display taste and not a picked ceiling on content: they are what
 * keeps rows comparable enough for the shared virtualizer's measured-average
 * reveal to land on the row it was asked for. The title gets the second line
 * because an entry title routinely carries a scope prefix and still has to be
 * told apart from its neighbours at a glance; the two supporting lines are one
 * each, because they are already single-line V1 protocol strings and a second
 * line could only ever come from wrapping.
 */
const TRIAGE_ROW_TITLE_LINES_V1 = 2;
const TRIAGE_ROW_SUPPORTING_LINES_V1 = 1;

/** Stable automation identity derived from the canonical collision-safe row key. */
export function triageListRowTestId(rowKey: string): string {
  return `triage-entry-row:${encodeURIComponent(rowKey)}`;
}

/**
 * The slots of one shared row: which already-projected word goes where, and
 * which of them the reader hears.
 *
 * The row's accessible NAME is the entry and only the entry. Without that the
 * shared `Item` composes a name from its text descendants, so an option was
 * announced — and addressed — as "Replace the duplicated
 * normalizerexample/repository", with no separator between the title and the
 * scope. Pinning the name to the title fixed that and then silenced everything
 * else the row shows, which is why the rest is a DESCRIPTION rather than a
 * longer name: `core/SURFACE.md` §7.1 requires the attention reason and the
 * freshness state to be announced, and a name that grows a sentence is a name
 * no assistive technology can be pointed at.
 *
 * The description is composed by the one shared announcement owner
 * (`ui/window/entryDisplay.ts#readTriageEntryRowAnnouncementV1`) rather than
 * here, because it says more than the row draws and every surface showing these
 * rows must say the same things: the entry's kind and lifecycle, which a
 * sighted reader takes from the section it is filed under and its state chip,
 * and whether what is on screen is still current, which they take from the
 * page's own freshness line. A reader moving row by row reaches none of those,
 * and §7.1 requires each of them per row.
 *
 * The title is never repeated: an entry that announced itself twice is the
 * failure the pinned name exists to prevent.
 */
/**
 * The row's leading mark: its lifecycle as a glyph, in the one tone that says
 * whether it needs the reader. Decorative for assistive technology — the
 * lifecycle is said in words in the context line and the description — so
 * glyph and colour are never the only carriers of state.
 */
export function readTriageRowMarkV1(
  row: Pick<TriageListDisplayRowV1, 'lifecyclePresentation' | 'detailKind' | 'tone'>,
  workflowSubject: TriageSourceWorkflowSubjectV1 | null = null,
): Readonly<{ name: IconName; tone: TextTone }> {
  const name = readTriageEntryGlyphV1(row.lifecyclePresentation, workflowSubject);
  const tone: TextTone = row.detailKind === 'presence' && row.tone !== 'neutral'
    ? row.tone
    : row.detailKind === 'attention' ? HAPPIER_WORK_STATUS_SEMANTIC_TONE.attention : 'secondary';
  return { name, tone };
}

/**
 * The tone of the detail header's attention badge: a required reason is the
 * entry's one loud fact, a suggestion stays quiet.
 */
export function readTriageAttentionBadgeToneV1(level: 'required' | 'suggested'): TextTone {
  return level === 'required' ? HAPPIER_WORK_STATUS_SEMANTIC_TONE.attention : 'secondary';
}

/** The table row's reason chip (one per row; the list's row key scopes it). */
export const TRIAGE_ROW_REASON_TEST_ID_V1 = 'triage-row-reason';

/**
 * An attention reason as a chip, led by its mark: the row's "Why it's here" cell and the detail header draw
 * this one component, so a reason reads the same wherever it appears. A required reason takes the attention
 * tint; a suggestion ("Mentioned") stays a neutral chip, because amber is reserved for needs-you.
 */
export function TriageAttentionReasonChip(props: Readonly<{
  level: 'required' | 'suggested';
  label: string;
  icon: string | null;
  testID?: string;
}>): React.ReactElement {
  const icon = props.icon !== null && isHappierIconName(props.icon) ? props.icon : undefined;
  return (
    <Badge
      variant="tinted"
      tone={readTriageAttentionBadgeToneV1(props.level)}
      value={props.label}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(icon === undefined ? {} : { icon })}
    />
  );
}

/**
 * The colour of the trailing detail. A required-attention reason is the row's
 * one loud fact and a presence problem keeps its caution; a suggestion, a
 * summary or a neutral note stays quiet. The title itself is never toned, so a
 * stale or dropped row still reads as a row (`DESIGN-SPEC` §5.5).
 */
export function readTriageRowDetailToneV1(
  row: Pick<TriageListDisplayRowV1, 'detail' | 'detailKind' | 'tone'>,
): TextTone | undefined {
  if (row.detail === null) return undefined;
  // Needs-you speaks the shared work status vocabulary's attention tone; blue stays for focus and links.
  if (row.detailKind === 'attention') return HAPPIER_WORK_STATUS_SEMANTIC_TONE.attention;
  if (row.detailKind === 'presence' && row.tone !== 'neutral') return row.tone;
  return undefined;
}

export function triageListRowItemProps(
  row: TriageListDisplayRowV1,
  busy: boolean,
  /**
   * The clock and locale the row's freshness is stated in. They are arguments
   * rather than reads of their own so that the announcement is a pure function
   * of the row and the moment it is rendered — and so this stays testable
   * without a mounted surface.
   */
  announcement: Readonly<{
    nowMs: number;
    locale: string;
    text?: TriageEntryDisplayTextV1;
    descriptor?: TriageSourceDescriptorV1 | null;
    source?: TriageListDisplayRowV1['entryRef']['source'];
    /** The words of the row's own Signal and Agent cells, so the description says what those cells show. */
    cells?: Readonly<{ signalLabel?: string; agentLabel?: string }>;
  }>,
): Pick<
  ListItemProps,
  | 'testID'
  | 'title'
  | 'subtitle'
  | 'detail'
  | 'titleNumberOfLines'
  | 'subtitleNumberOfLines'
  | 'detailNumberOfLines'
  | 'detailTone'
  | 'busy'
  | 'accessibilityLabel'
  | 'accessibilityHint'
> {
  const context = readTriageEntryRowContextV1(row, announcement.descriptor, announcement.source);
  // The provider's own last-activity age, when it reports one: quiet, at the
  // end of the context line, and said in the same place it is shown.
  const activityLabel = row.activityAtMs === null
    ? undefined
    : formatTriageTimestampV1(announcement.locale, row.activityAtMs, 'relative', announcement.nowMs);
  const detailTone = readTriageRowDetailToneV1(row);
  return {
    testID: triageListRowTestId(row.key),
    title: row.title,
    subtitle: activityLabel === undefined ? context.label : `${context.label} · ${activityLabel}`,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(detailTone === undefined ? {} : { detailTone }),
    // The virtualizer this row is mounted in has no fixed height and reveals an
    // unmounted row by `averageItemLength * index`. A provider title is a
    // bounded 4 KiB string, not a bounded LINE COUNT: one entry titled with a
    // paragraph makes every scroll estimate on the page describe a row that
    // does not exist. Two lines keeps a long title readable — it is the visible
    // truncation `ellipsizeMode` already renders, not a dropped fact, and the
    // whole title still reaches assistive technology as the row's accessible
    // NAME below and its detail region shows it in full.
    titleNumberOfLines: TRIAGE_ROW_TITLE_LINES_V1,
    subtitleNumberOfLines: TRIAGE_ROW_SUPPORTING_LINES_V1,
    detailNumberOfLines: TRIAGE_ROW_SUPPORTING_LINES_V1,
    busy,
    accessibilityLabel: row.title,
    accessibilityHint: readTriageEntryRowAnnouncementV1({
      ...row,
      contextDescription: context.description,
      ...(activityLabel === undefined ? {} : { activityLabel }),
      ...announcement.cells,
    }, announcement),
  };
}


/**
 * A compact, locale-owned age for the table's tabular Age column ("18m", "2h", "3d", "10w", "2y"). The row's accessible
 * description keeps the full relative phrase; this is only what fits the column.
 */
export function formatTriageCompactAgeV1(locale: string, atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  const [value, unit] = seconds < 3_600
    ? [Math.max(1, Math.round(seconds / 60)), 'minute' as const]
    : seconds < 86_400
      ? [Math.round(seconds / 3_600), 'hour' as const]
      : seconds < 30 * 86_400
        ? [Math.round(seconds / 86_400), 'day' as const]
        // Weeks up to a year, then years: a narrow month ("3m") would read as minutes in this column.
        : seconds < 365 * 86_400
          ? [Math.round(seconds / (7 * 86_400)), 'week' as const]
          : [Math.round(seconds / (365 * 86_400)), 'year' as const];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
}

/**
 * What every row of the mounted list shares: the Pin/Unpin handlers and the one activation path. The Collection
 * renders rows itself, so a row reads these from here rather than through a closure per row.
 */
export type TriageListRowEnvironmentV1 = Readonly<{
  handlers: TriageRowPinHandlersV1;
  /** Opens the entry exactly as a row press does (the peek's Open). */
  onOpen: (key: string) => void;
}>;

export const TriageListRowEnvironmentContext = React.createContext<TriageListRowEnvironmentV1 | null>(null);

function useTriageListRowEnvironment(): TriageListRowEnvironmentV1 {
  const environment = React.useContext(TriageListRowEnvironmentContext);
  if (environment === null) throw new Error('A PRs & Issues row rendered outside its list.');
  return environment;
}

/**
 * The row's own controls beside its press target, which is the one Pin/Unpin affordance per row, offered through
 * the public secondary-action owner for every row (a pin this mount never materialized included).
 *
 * It is the Collection's row-actions hook: called inside each row, so the shared selection owner's per-row
 * facts commit this row and the row that lost the anchor, not every mounted cell.
 */
export function useTriageListRowActions(item: TriageListItemV1): CollectionRowActions {
  const { row } = item;
  const { handlers } = useTriageListRowEnvironment();
  // `{title}` interpolation is why these cannot go through `secondaryActions[].labelKey`: those resolve without
  // a values argument, so a placeholder would reach the reader verbatim.
  const text = usePluginTranslation();
  const busy = handlers.busyKey === row.key;
  const disabled = handlers.unavailableReason !== null;
  const onSecondaryAction = React.useCallback((actionId: string) => {
    if (actionId === PIN_ACTION_ID) handlers.onSetPinned(row);
  }, [handlers, row]);
  return {
    busy,
    secondaryActions: triageListRowSecondaryActionsV1({
      pinLabel: row.pinned
        ? text('plugins.triage.surface.row.unpinShort', 'Unpin')
        : text('plugins.triage.surface.row.pinShort', 'Pin'),
      pinDisabled: disabled,
    }),
    // Kept as an explicit override: plugin-ui's default resolves against the MOUNTED plugin's catalog, which
    // Triage does not declare, so dropping this would degrade to English rather than inherit a translation.
    secondaryActionAccessibilityLabel: text('plugins.triage.surface.row.moreActions', 'More actions for {title}', { title: row.title }),
    onSecondaryAction,
  };
}

/** The peek: the source's own summary, what the row already knows, and what a reader does next. */
function TriageListPeek(props: Readonly<{ item: TriageListItemV1 }>): React.ReactElement {
  const { row, summary } = props.item;
  const { handlers, onOpen } = useTriageListRowEnvironment();
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const webUrl = props.item.locator?.webUrl ?? null;
  const surfaceContext = useSurfaceContext();
  const descriptor = readTriageSourceDescriptorV1(surfaceContext, row.entryRef.source);
  const context = readTriageEntryRowContextV1(row, descriptor, row.entryRef.source);
  return (
    <Stack gap="small">
      <Text variant="micro" tone="secondary" value={context.label} numberOfLines={1} />
      {summary === null ? null : <Text variant="meta" tone="secondary" value={summary} numberOfLines={3} />}
      <Row gap="small" wrap>
        {row.sourceInstanceId === null ? null : (
          <Button
            title={text('plugins.triage.surface.peek.open', 'Open')}
            variant="primary"
            size="small"
            onPress={() => { onOpen(row.key); }}
          />
        )}
        <Button
          title={row.pinned
            ? text('plugins.triage.surface.row.unpinShort', 'Unpin')
            : text('plugins.triage.surface.peek.pin', 'Pin')}
          accessibilityLabel={readTriagePinActionLabelV1(row, text)}
          variant="secondary"
          size="small"
          busy={handlers.busyKey === row.key}
          disabled={handlers.unavailableReason !== null}
          onPress={() => { handlers.onSetPinned(row); }}
        />
        {webUrl === null ? null : (
          <Button
            // The same destination and words as the detail header's Open at the source.
            title={text('plugins.triage.surface.detail.openAtSource', 'Open at the source')}
            // A peer of Pin in the peek's one row of chips (lab `merged-list`): Open leads, the rest are equal.
            variant="secondary"
            size="small"
            onPress={() => { void hostApi.openExternalLink(webUrl); }}
          />
        )}
      </Row>
    </Stack>
  );
}

/** A cell's mark: the tone it is drawn in, whether it draws a dot at all, and whether the dot moves. */
export type TriageCellMarkV1 = Readonly<{ tone: TextTone; marked: boolean; live: boolean }>;

const QUIET_CELL_MARK_V1: TriageCellMarkV1 = Object.freeze({ tone: 'secondary', marked: false, live: false });

/**
 * A source's status fact as a cell mark, in the shared status vocabulary: a healthy fact ("Checks
 * passed") says nothing, news is an ink dot, a caution the attention tone and a failure danger.
 */
export function readTriageSignalCellMarkV1(tone: TriageListRowSignalV1['tone']): TriageCellMarkV1 {
  // The tone is the contract's one status-fact projection; the cell only decides whether it marks.
  if (tone === 'success' || tone === 'neutral') return QUIET_CELL_MARK_V1;
  return { tone: resolveTriageRowFactStatusToneV1(tone), marked: true, live: false };
}

/** The row glyph's corner badge for its linked agent: what it shows, and the ring tone that says its state. */
export type TriageAgentBadgeV1 = Readonly<{ mark: 'live' | 'attention' | 'error' | 'check'; tone?: TextTone }>;

/**
 * The linked agent as the list row glyph's badge (the table says the same in its Agent column): a hand while
 * it waits on the reader, a live dot while it works, the failure or the finish in their tones. An offline or
 * archived Session is history, not a state, so it draws no badge.
 */
export function readTriageAgentBadgeV1(agent: Pick<TriageAgentStatusV1, 'kind' | 'tone' | 'live'>): TriageAgentBadgeV1 | null {
  switch (agent.kind) {
    case 'permission':
    case 'action':
    case 'input':
      return { mark: 'attention', tone: HAPPIER_WORK_STATUS_SEMANTIC_TONE.attention };
    case 'working':
      return { mark: 'live' };
    case 'failed':
      return { mark: 'error', tone: 'danger' };
    case 'ready':
      return { mark: 'check', tone: 'success' };
    case 'offline':
    case 'archived':
      return null;
  }
}

/** The linked agent as a cell mark: working is the one moving mark, in the ink; needs-you and trouble keep their tone. */
export function readTriageAgentCellMarkV1(agent: Pick<TriageAgentStatusV1, 'tone' | 'live'>): TriageCellMarkV1 {
  if (agent.tone !== 'neutral') return { tone: HAPPIER_WORK_STATUS_SEMANTIC_TONE[agent.tone], marked: true, live: agent.live };
  return agent.live ? { tone: 'secondary', marked: true, live: true } : QUIET_CELL_MARK_V1;
}

const TRIAGE_CELL_STATE_STYLE_V1 = Object.freeze({ minWidth: 0, maxWidth: '100%' as const });
const TRIAGE_CELL_STATE_WORD_STYLE_V1 = Object.freeze({ flexShrink: 1, minWidth: 0 });
/** The designation never gives up width ("#2481" stays whole beside a wide reason chip). */
const TRIAGE_CELL_KEEP_STYLE_V1 = Object.freeze({ flexShrink: 0 });
/**
 * The author takes only the width the place and designation leave (no basis of its own), so it is truncated
 * first and gone before the place gives up a letter (lab `merged-list-phone`: "payments-api #2481 · Ma…").
 * A shrink weight alone cannot promise that order: shrinking is shared in proportion to each part's width.
 */
const TRIAGE_CELL_TRAIL_STYLE_V1 = Object.freeze({ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 });

/**
 * Where an entry lives, in words: its scope when the designation is said beside the title, else the source's own
 * address (which carries the designation itself).
 */
export function readTriageRowPlaceV1(
  row: Pick<TriageListDisplayRowV1, 'designation' | 'identifierLabel' | 'scopeLabel' | 'scopeDisplayName'>,
): string {
  return row.scopeDisplayName ?? (row.designation === null ? row.identifierLabel ?? row.scopeLabel : row.scopeLabel);
}

/** The list byline's parts: the place, which truncates, and the designation after it ("#2481"), which does not. */
export function readTriageRowBylinePartsV1(
  row: Pick<TriageListDisplayRowV1, 'designation' | 'identifierLabel' | 'scopeLabel' | 'scopeDisplayName'>,
): Readonly<{ place: string; designation: string | null }> {
  return { place: readTriageRowPlaceV1(row), designation: row.designation };
}

/** The list byline's place with the designation after it ("payments-api #2481"), else the place alone. */
export function readTriageRowBylinePlaceV1(
  row: Pick<TriageListDisplayRowV1, 'designation' | 'identifierLabel' | 'scopeLabel' | 'scopeDisplayName'>,
): string {
  const { place, designation } = readTriageRowBylinePartsV1(row);
  return designation === null ? place : `${place} ${designation}`;
}

/**
 * Where an entry lives, led by its source's own mark so GitHub, GitLab and Sentry rows tell apart at a glance.
 * `keep` (the designation) is said after the place and is the last thing a narrow row gives up; `trail` (who
 * opened it) goes after it and gives way before it.
 */
function TriageRowWhere(props: Readonly<{ pluginId: string; label: string; keep?: string | null; trail?: string | null }>): React.ReactElement {
  return (
    <Row gap="xsmall" align="center" style={TRIAGE_CELL_STATE_STYLE_V1}>
      <BrandMark pluginId={props.pluginId} size="small" externallyLabelled />
      <Stack style={TRIAGE_CELL_STATE_WORD_STYLE_V1}>
        <Text variant="meta" tone="secondary" value={props.label} numberOfLines={1} />
      </Stack>
      {props.keep == null ? null : (
        <Stack style={TRIAGE_CELL_KEEP_STYLE_V1}>
          <Text variant="meta" tone="secondary" value={props.keep} numberOfLines={1} />
        </Stack>
      )}
      {props.trail == null ? null : (
        <Stack style={TRIAGE_CELL_TRAIL_STYLE_V1}>
          <Text variant="meta" tone="secondary" value={`· ${props.trail}`} numberOfLines={1} />
        </Stack>
      )}
    </Row>
  );
}

/**
 * Whether a row says why it is here: a reason that is not only a summary, and not the one suggestion its group's
 * line already says for every entry (`readTriageSharedGroupReasonsV1`). The column is drawn only while a row does.
 */
export function readTriageRowSaysReasonV1(
  item: Pick<TriageListItemV1, 'row' | 'group'>,
  sharedGroupReasons: ReadonlyMap<TriageListGroupIdV1, string>,
): boolean {
  const { row } = item;
  if (row.detail === null || row.detailKind === 'summary') return false;
  return !(row.detailKind === 'suggestion' && sharedGroupReasons.get(item.group) === row.detail);
}

/**
 * The PRs & Issues row anatomy: which already-projected word goes in which Collection slot. The entry is the
 * row's accessible NAME and only the entry; everything else a sighted reader takes from the row's surroundings is
 * its description, composed by the one announcement owner (`triageListRowItemProps`).
 */
export function useTriageListAnatomyV1(input: Readonly<{
  withSignal: boolean;
  withAgent?: boolean;
  /** Whether any row says why it is here (`readTriageRowSaysReasonV1`); otherwise the column is not drawn. */
  withReason?: boolean;
  organizing?: boolean;
  /** Groups whose one shared suggestion their header already says (`readTriageSharedGroupReasonsV1`). */
  sharedGroupReasons?: ReadonlyMap<TriageListGroupIdV1, string>;
  /**
   * The Tasks lens (lab `tasks-list`): the status category as the glyph, the source's own status word in a Status
   * column after the task, and the relation hint (sub-tasks done, blocked) in Progress. Why-it's-here reasons and
   * the PR signal stay on PRs & Issues; the agent's state stays in Agent.
   */
  tasks?: boolean;
  taskItems?: readonly TriageListItemV1[];
  personalTaskOrder?: PersonalTaskOrder | null;
  onTaskOrderOutcome?: () => void;
  /** After a row's status control wrote at the source: the list's authoritative reread. */
  onTaskApplied?: () => Promise<void>;
}>): CollectionAnatomy<TriageListItemV1> {
  const text = usePluginTranslation();
  const { locale, targetedContributions } = useSurfaceContext();
  // Row facts read only these serialized contributions and the locale. Other
  // host-context pushes must not replace every row's anatomy and callbacks.
  const contributionSnapshotJson = JSON.stringify(targetedContributions);
  // A column no listed entry fills is not drawn: an all-dash Agent column is noise, like an all-dash Signal one.
  const { withAgent = true, organizing = false, sharedGroupReasons = NO_SHARED_GROUP_REASONS, tasks = false, onTaskApplied = NO_TASK_REREAD } = input;
  const withSignal = input.withSignal && !tasks;
  const withReason = (input.withReason ?? true) && !tasks;
  const { taskItems, personalTaskOrder, onTaskOrderOutcome } = input;
  return React.useMemo<CollectionAnatomy<TriageListItemV1>>(() => {
    const descriptorOf = (item: TriageListItemV1) => resolveTriageSourceDescriptorV1(targetedContributions, item.row.entryRef.source);
    const agent = (item: TriageListItemV1) => {
      if (item.agent === null) return null;
      const mark = readTriageAgentCellMarkV1(item.agent);
      return <Status presentation="inline" tone={mark.tone} indicator={mark.marked} pulsing={mark.live}
        label={text(item.agent.labelKey, item.agent.label, item.agent.labelParams)}
        leading={item.agent.agent?.brand === undefined ? undefined : <BrandMark pluginId={item.agent.agent.brand.pluginId} size="small" pixelSize={resolveHappierIconSize('small')} externallyLabelled />} />;
    };
    const unfinished = new Set(personalTaskOrder?.undoneOrder ?? []);
    const orderByGroup = new Map<TriageListGroupIdV1, string[]>();
    for (const item of taskItems ?? []) {
      if (!isInternalTaskReferenceV1(item.row.entryRef) || !unfinished.has(item.row.entryRef.entryId)) continue;
      const group = orderByGroup.get(item.group) ?? [];
      group.push(item.row.entryRef.entryId); orderByGroup.set(item.group, group);
    }
    return {
      wrapItem: (item, children) => {
        const { row, locator } = item;
        if (!row.materialized || row.sourceInstanceId === null || locator == null) return children;
        const context = readTriageEntryRowContextV1(row, descriptorOf(item), row.entryRef.source);
        const sessionTarget = <DropTarget
          targetId={TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1}
          input={{ entryRef: row.entryRef, display: { locator, scopeLabel: row.scopeLabel }, preview: {
            verb: text('plugins.triage.surface.drop.linkSession', 'Link Session'), target: row.title,
            consequence: text('plugins.triage.sessionLinks.linkReassurance', 'Linking doesn’t change anything at the source.'),
          } }} testID={`triage-entry-session-drop:${encodeURIComponent(row.key)}`}>{children}</DropTarget>;
        const personal = isInternalTaskReferenceV1(row.entryRef);
        const unavailableReason = !personal ? text('plugins.triage.tasks.order.external', 'External tasks keep their source order.')
          : personalTaskOrder == null ? text('plugins.triage.tasks.order.unavailable', 'Task order is unavailable. Refresh and try again.')
            : text('plugins.triage.tasks.order.unfinished', 'Only unfinished personal tasks in the same group can be reordered.');
        return (
          <DragSource
            sourceId={TRIAGE_ENTRY_DRAG_SOURCE_ID_V1}
            organizing={organizing}
            {...(tasks && personal ? { onDropOutcome: onTaskOrderOutcome } : {})}
            reference={{
              entryRef: row.entryRef,
              sourceInstance: { source: row.entryRef.source, sourceInstanceId: row.sourceInstanceId },
              lastKnownLocator: locator,
              title: row.title,
              subtitle: context.label,
            }}
            testID={`triage-entry-drag:${encodeURIComponent(row.key)}`}
          >
            {tasks ? <DropTarget targetId={TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1}
              input={{ ...(personalTaskOrder == null ? {} : { scope: personalTaskOrder.scope }),
                targetId: row.entryRef.entryId, orderedIds: personal ? orderByGroup.get(item.group) ?? [] : [],
                preview: { before: text('plugins.triage.tasks.order.before', 'Move before'), after: text('plugins.triage.tasks.order.after', 'Move after'), target: row.title },
                unavailableReason,
              }} testID={`triage-task-order-drop:${encodeURIComponent(row.key)}`}>{sessionTarget}</DropTarget> : sessionTarget}
          </DragSource>
        );
      },
      glyph: (item) => {
        const category = item.task?.category ?? null;
        if (category !== null) return <TaskStatusGlyph category={category} />;
        const mark = readTriageRowMarkV1(
          item.row,
          resolveTriageSourceWorkflowSubjectV1(targetedContributions, item.row.entryRef),
        );
        return <Icon name={mark.name} size="small" tone={mark.tone} />;
      },
      glyphBadge: (item) => {
        const badge = item.agent === null ? null : readTriageAgentBadgeV1(item.agent);
        if (badge === null) return null;
        const brand = item.agent?.agent?.brand;
        if (brand !== undefined) return {
          mark: (pixelSize) => <BrandMark pluginId={brand.pluginId} size="small" pixelSize={pixelSize} externallyLabelled />,
          ...(badge.tone === undefined ? {} : { tone: badge.tone }),
        };
        return badge.mark === 'live'
          ? { live: true }
          : { icon: badge.mark, ...(badge.tone === undefined ? {} : { tone: badge.tone }) };
      },
      // A task's status glyph is its control when its selected connection offers a workflow (lab decision 3).
      ...(tasks ? { leadingControl: (item: TriageListItemV1) => {
        const task = item.task ?? null;
        const { row, locator } = item;
        // A stale row is last-known content: its glyph stays a mark until the source answers again.
        if (task === null || task.category === null || (task.transitions?.length ?? 0) === 0
          || row.stale || row.sourceInstanceId === null || locator == null) return null;
        return <TriageTaskRowStatusControl task={task} onApplied={onTaskApplied}
          address={{ entryRef: row.entryRef, sourceInstanceId: row.sourceInstanceId, lastKnownLocator: locator }} />;
      } } : {}),
      title: (item) => item.row.title,
      // The table says the designation quietly after the title ("Retry … #2481") and Where is the place alone.
      titleSuffix: (item) => item.row.designation,
      where: (item) => <TriageRowWhere pluginId={item.row.entryRef.source.pluginId} label={readTriageRowPlaceV1(item.row)} />,
      // The list says the place with the designation, and who opened it ("payments-api #2481 · Mara Oduya"); the
      // full source address stays in the peek and the detail.
      byline: (item) => {
        const { row } = item;
        const { place, designation } = readTriageRowBylinePartsV1(row);
        return (
          <TriageRowWhere
            pluginId={row.entryRef.source.pluginId}
            label={place}
            keep={designation}
            trail={tasks ? item.task?.statusLabel ?? null : row.authorLabel}
          />
        );
      },
      ...(tasks ? { fields: [{
        key: 'status',
        title: text('plugins.triage.tasks.column.status', 'Status'),
        leading: true,
        minWidth: 104,
        priority: 3,
        render: (item: TriageListItemV1) => item.task?.statusLabel == null ? null
          : <Text variant="meta" tone="secondary" value={item.task.statusLabel} numberOfLines={1} />,
      }, {
        key: 'progress',
        title: text('plugins.triage.tasks.column.progress', 'Progress'),
        minWidth: 120,
        priority: 2,
        render: (item: TriageListItemV1) => {
          const progress = readTriageTaskProgressV1(item.task?.relations ?? null, text);
          return progress === null ? null : <Text variant="meta" tone="secondary" value={progress} numberOfLines={1} />;
        },
      }, {
        key: 'due',
        title: text('plugins.triage.tasks.column.due', 'Due'),
        minWidth: 96,
        priority: 1,
        render: (item: TriageListItemV1) => {
          const due = item.task == null ? null : readTriageTaskDueV1(item.task.dueDate, item.task.category, locale, Date.now(), text);
          if (due === null) return null;
          return <Text variant="meta" tone={due.tone ?? 'secondary'} value={due.label} numberOfLines={1} />;
        },
      }] } : {}),
      ...(tasks ? { listFact: createTriageTaskListFactV1({ locale, text, renderAgent: agent }) } : {}),
      ...(withReason ? { reason: (item: TriageListItemV1) => {
        const { row } = item;
        // The group's header already says the one suggestion all its rows share; the row does not repeat it.
        if (row.detail === null || !readTriageRowSaysReasonV1(item, sharedGroupReasons)) return null;
        // An attention reason is the detail header's chip, required or suggested (one owner for both places).
        if (row.detailKind === 'attention' || row.detailKind === 'suggestion') {
          return (
            <TriageAttentionReasonChip
              level={row.detailKind === 'attention' ? 'required' : 'suggested'}
              label={row.detail}
              icon={row.detailIcon}
              testID={TRIAGE_ROW_REASON_TEST_ID_V1}
            />
          );
        }
        // A presence problem keeps its caution as a tinted chip; a neutral note stays plain words.
        const tone: TextTone = readTriageRowDetailToneV1(row) ?? 'secondary';
        if (tone === 'secondary') return <Text variant="meta" tone={tone} value={row.detail} numberOfLines={1} />;
        return <Badge variant="tinted" tone={tone} value={row.detail} />;
      } } : {}),
      ...(withSignal ? {
        signal: (item: TriageListItemV1) => {
          if (item.signal === null) return null;
          const mark = readTriageSignalCellMarkV1(item.signal.tone);
          return <Status presentation="inline" tone={mark.tone} indicator={mark.marked} pulsing={mark.live} label={item.signal.label} />;
        },
      } : {}),
      ...(withAgent ? { agent } : {}),
      age: (item) => (item.row.activityAtMs === null
        ? null
        : formatTriageCompactAgeV1(locale, item.row.activityAtMs, Date.now())),
      peek: (item) => <TriageListPeek item={item} />,
      accessibilityLabel: (item) => item.row.title,
      accessibilityHint: (item) => triageListRowItemProps(item.row, false, {
        nowMs: Date.now(),
        locale,
        descriptor: descriptorOf(item),
        source: item.row.entryRef.source,
        text,
        cells: {
          ...(withSignal && item.signal !== null ? { signalLabel: item.signal.label } : {}),
          ...(item.agent === null ? {} : { agentLabel: text(item.agent.labelKey, item.agent.label, item.agent.labelParams) }),
        },
      }).accessibilityHint,
      testID: (item) => triageListRowTestId(item.row.key),
      columnTitles: {
        title: tasks ? text('plugins.triage.tasks.column.task', 'Task') : text('plugins.triage.surface.column.entry', 'Entry'),
        where: text('plugins.triage.surface.column.where', 'Where'),
        reason: text('plugins.triage.surface.column.reason', 'Why it’s here'),
        signal: text('plugins.triage.surface.column.signal', 'Signal'),
        agent: text('plugins.triage.surface.column.agent', 'Agent'),
        age: text('plugins.triage.surface.column.age', 'Age'),
      },
    };
  }, [contributionSnapshotJson, locale, onTaskApplied, organizing, sharedGroupReasons, tasks, text, withAgent, withReason, withSignal, taskItems, personalTaskOrder, onTaskOrderOutcome]);
}

/**
 * A task's relation hint for its Progress cell, from the source's live relations: a blocker first (it decides what
 * can happen next), then sub-tasks done ("3 of 5"), then the parent it belongs to. Unread relations say nothing:
 * absent is unknown, never "none".
 */
export function readTriageTaskProgressV1(
  relations: TriageEntryRelationsV1 | null,
  text: PluginTranslate,
): string | null {
  if (relations === null) return null;
  const blockers = relations.blockedBy?.length ?? 0;
  if (blockers > 0) return text('plugins.triage.tasks.progress.blocked', 'Blocked');
  const children = relations.children;
  if (children !== undefined && children.total > 0) {
    return children.completed === undefined
      ? text('plugins.triage.tasks.progress.subtasks', '{total} sub-tasks', { total: children.total })
      : text('plugins.triage.tasks.progress.done', '{completed} of {total}', { completed: children.completed, total: children.total });
  }
  if (relations.parent !== undefined) return text('plugins.triage.tasks.progress.subtask', 'Sub-task');
  return null;
}
