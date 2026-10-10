import * as React from 'react';
import {
  Badge,
  BrandMark,
  Button,
  DragSource,
  DropTarget,
  Icon,
  Row,
  Stack,
  Text,
  useListMultiSelectionRow,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type CollectionAnatomy,
  type CollectionRowActions,
  type IconName,
  type ListItemProps,
  type TextTone,
} from '@happier-dev/plugin-ui';
import {
  HAPPIER_TONE_COLOR_TOKEN,
  HAPPIER_WORK_STATUS_SEMANTIC_TONE,
  HappierStatusDot,
  isHappierIconName,
  resolveHappierIconSize,
} from '@happier-dev/plugin-ui/presentation';
import { formatTriageTimestampV1, resolveTriageRowFactStatusToneV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageSourceDescriptorV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageSourceDescriptorV1 } from '../detail/sourceSurface.js';
import {
  readTriageEntryRowAnnouncementV1,
  readTriageEntryRowContextV1,
  type TriageEntryDisplayTextV1,
} from '../window/entryDisplay.js';
import type { TriageListItemV1, TriageListRowSignalV1 } from './sections.js';
import type { TriageAgentStatusV1 } from '../detail/agentState.js';
import { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1 } from './entryDragDrop.js';

/**
 * One PRs & Issues row.
 *
 * The row is the shared Collection's (`@happier-dev/plugin-ui` `Collection`, presenting through the one `List`
 * engine): activation, selection semantics, keyboard behavior, focus registration, target size, the table and list
 * geometries and the peek are all owned there (`core/SURFACE.md` §1.2, COLLECTION.md §3). The only things this
 * file decides are which already-projected words go in which anatomy slot, and which single Pin/Unpin affordance
 * the row carries.
 *
 * There is exactly one such affordance per row, and it is never two states of two controls. A materialized row
 * offers it through the public secondary-action owner, which keeps the overflow outside the row press target and
 * owns the menu's focus and keyboard behavior. A pinned row this mount never materialized carries an inline
 * **Unpin** instead, because it has no detail panel to host the operation and dropping it would strand a pin the
 * reader cannot remove.
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
 * The row's own way into a bulk selection, and the ONLY one a touch reader has.
 *
 * The shared `List` already turns a modified press into a set and an unmodified
 * press into a toggle once a set is being built — but a finger has no Command
 * key, so without a stated affordance the whole capability is desktop-only. It
 * lives in the row's existing secondary-action overflow rather than as a new
 * control: that owner already handles focus, keyboard activation and the touch
 * target, and it keeps the press target of the row itself unchanged.
 */
export const TRIAGE_ROW_SELECT_ACTION_ID_V1 = 'toggle-selected';

/**
 * The row's secondary actions, in the order a reader meets them.
 *
 * Select comes first because it is the affordance a touch reader has no other
 * way to reach, while Pin is also reachable from the entry's own detail. The
 * order is decided here rather than inline so it can be stated and falsified
 * rather than re-derived from a JSX literal.
 */
export function triageListRowSecondaryActionsV1(input: Readonly<{
  selectLabel: string;
  pinLabel: string;
  pinDisabled: boolean;
}>): readonly Readonly<{ id: string; label: string; disabled?: boolean }>[] {
  return [
    { id: TRIAGE_ROW_SELECT_ACTION_ID_V1, label: input.selectLabel },
    { id: PIN_ACTION_ID, label: input.pinLabel, disabled: input.pinDisabled },
  ];
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
 * The one glyph an entry wears, in its row and in its detail header: its kind
 * while it is open (a pull request, an issue, an error group), then where its
 * lifecycle ended. A kind nobody declared keeps the lifecycle glyph rather than
 * a guess at what the entry is.
 */
export function readTriageEntryGlyphV1(
  lifecycle: TriageListDisplayRowV1['lifecyclePresentation'],
  workflowSubject: TriageSourceWorkflowSubjectV1 | null,
): IconName {
  if (lifecycle === 'closed' || lifecycle === 'suppressed') return 'close';
  if (lifecycle === 'resolved') {
    return workflowSubject === null || workflowSubject === 'pullRequest' ? 'change-complete' : 'check';
  }
  if (lifecycle !== 'active') return 'info';
  if (workflowSubject === 'issue') return 'issue';
  if (workflowSubject === 'errorIssue') return 'bug';
  if (workflowSubject === 'other') return 'info';
  return 'change-open';
}

/**
 * The tone of the detail header's attention badge: a required reason is the
 * entry's one loud fact, a suggestion stays quiet.
 */
export function readTriageAttentionBadgeToneV1(level: 'required' | 'suggested'): TextTone {
  return level === 'required' ? HAPPIER_WORK_STATUS_SEMANTIC_TONE.attention : 'secondary';
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
 * A compact, locale-owned age for the table's tabular Age column ("18m", "2h", "3d"). The row's accessible
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
        : [Math.round(seconds / (7 * 86_400)), 'week' as const];
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
 * The row's own controls beside its press target, which is the one Pin/Unpin affordance per row. A
 * materialized row offers Select and Pin through the public secondary-action owner; a pinned row this mount never
 * materialized carries an inline **Unpin**, because it has no detail to host the operation and dropping it would
 * strand a pin the reader cannot remove.
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
  const label = readTriagePinActionLabelV1(row, text);
  const selection = useListMultiSelectionRow(row.key);
  const selectLabel = selection.isSelected
    ? text('plugins.triage.surface.row.deselect', 'Deselect {title}', { title: row.title })
    : text('plugins.triage.surface.row.select', 'Select {title}', { title: row.title });
  const onSecondaryAction = React.useCallback((actionId: string) => {
    // `replace` rather than `toggle` for the first row: turning selection mode on AND choosing the row the reader
    // pressed is one gesture, and entering an empty selection mode would make the bar appear with nothing in it.
    if (actionId === TRIAGE_ROW_SELECT_ACTION_ID_V1) {
      if (selection.isSelectionMode) selection.toggle();
      else selection.replace();
      return;
    }
    handlers.onSetPinned(row);
  }, [handlers, row, selection]);
  if (!row.materialized) {
    return {
      busy,
      accessory: (
        <Button
          // A short visible verb; the full "Unpin {title}" stays the name a reader hears.
          title={text('plugins.triage.surface.row.unpinShort', 'Unpin')}
          accessibilityLabel={label}
          variant="plain"
          busy={busy}
          disabled={disabled}
          onPress={() => { handlers.onSetPinned(row); }}
        />
      ),
    };
  }
  return {
    busy,
    secondaryActions: triageListRowSecondaryActionsV1({ selectLabel, pinLabel: label, pinDisabled: disabled }),
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
      <Text variant="caption" tone="secondary" value={context.label} numberOfLines={1} />
      {summary === null ? null : <Text variant="body" tone="secondary" value={summary} numberOfLines={3} />}
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
            variant="plain"
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

/**
 * A cell's state as a small tone mark beside a quiet word ("Checks passed", "Working"): the colour is
 * the glance, the word is the meaning. It is not a `Status` because a row cell is not a notice — it is
 * one line that truncates inside a fixed cell, and it is never a live region: the row's own description
 * says the same words (`cells` in `triageListRowItemProps`), so thirty announcing cells would only be noise.
 */
function TriageCellState(props: Readonly<{ mark: TriageCellMarkV1; label: string; brandPluginId?: string }>): React.ReactElement {
  const theme = usePluginTheme();
  return (
    <Row gap="xsmall" align="center" style={TRIAGE_CELL_STATE_STYLE_V1}>
      {props.brandPluginId === undefined ? null : (
        <BrandMark pluginId={props.brandPluginId} size="small" pixelSize={resolveHappierIconSize('small')} externallyLabelled />
      )}
      {props.mark.marked
        ? <HappierStatusDot color={theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.mark.tone]]} isPulsing={props.mark.live} />
        : null}
      <Stack style={TRIAGE_CELL_STATE_WORD_STYLE_V1}>
        <Text variant="body" tone="secondary" value={props.label} numberOfLines={1} />
      </Stack>
    </Row>
  );
}

const TRIAGE_CELL_STATE_STYLE_V1 = Object.freeze({ minWidth: 0, maxWidth: '100%' as const });
const TRIAGE_CELL_STATE_WORD_STYLE_V1 = Object.freeze({ flexShrink: 1, minWidth: 0 });

/**
 * Where an entry lives, in words: its scope when the designation is said beside the title, else the source's own
 * address (which carries the designation itself).
 */
export function readTriageRowPlaceV1(
  row: Pick<TriageListDisplayRowV1, 'designation' | 'identifierLabel' | 'scopeLabel'>,
): string {
  return row.designation === null ? row.identifierLabel ?? row.scopeLabel : row.scopeLabel;
}

/** Where an entry lives, led by its source's own mark so GitHub, GitLab and Sentry rows tell apart at a glance. */
function TriageRowWhere(props: Readonly<{ pluginId: string; label: string }>): React.ReactElement {
  return (
    <Row gap="xsmall" align="center" style={TRIAGE_CELL_STATE_STYLE_V1}>
      <BrandMark pluginId={props.pluginId} size="small" externallyLabelled />
      <Stack style={TRIAGE_CELL_STATE_WORD_STYLE_V1}>
        <Text variant="body" tone="secondary" value={props.label} numberOfLines={1} />
      </Stack>
    </Row>
  );
}

/**
 * The PRs & Issues row anatomy: which already-projected word goes in which Collection slot. The entry is the
 * row's accessible NAME and only the entry; everything else a sighted reader takes from the row's surroundings is
 * its description, composed by the one announcement owner (`triageListRowItemProps`).
 */
export function useTriageListAnatomyV1(input: Readonly<{ withSignal: boolean; organizing?: boolean }>): CollectionAnatomy<TriageListItemV1> {
  const text = usePluginTranslation();
  const surfaceContext = useSurfaceContext();
  const { withSignal, organizing = false } = input;
  return React.useMemo<CollectionAnatomy<TriageListItemV1>>(() => {
    const descriptorOf = (item: TriageListItemV1) => readTriageSourceDescriptorV1(surfaceContext, item.row.entryRef.source);
    return {
      wrapItem: (item, children) => {
        const { row, locator } = item;
        if (!row.materialized || row.sourceInstanceId === null || locator == null) return children;
        const context = readTriageEntryRowContextV1(row, descriptorOf(item), row.entryRef.source);
        return (
          <DragSource
            sourceId={TRIAGE_ENTRY_DRAG_SOURCE_ID_V1}
            organizing={organizing}
            reference={{
              entryRef: row.entryRef,
              sourceInstance: { source: row.entryRef.source, sourceInstanceId: row.sourceInstanceId },
              lastKnownLocator: locator,
              title: row.title,
              subtitle: context.label,
            }}
            testID={`triage-entry-drag:${encodeURIComponent(row.key)}`}
          >
            <DropTarget
              targetId={TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1}
              input={{
                entryRef: row.entryRef,
                display: { locator, scopeLabel: row.scopeLabel },
                preview: {
                  verb: text('plugins.triage.surface.drop.linkSession', 'Link Session'),
                  target: row.title,
                  consequence: text('plugins.triage.sessionLinks.linkReassurance', 'Linking doesn’t change anything at the source.'),
                },
              }}
              testID={`triage-entry-session-drop:${encodeURIComponent(row.key)}`}
            >
              {children}
            </DropTarget>
          </DragSource>
        );
      },
      glyph: (item) => {
        const descriptor = descriptorOf(item);
        const mark = readTriageRowMarkV1(
          item.row,
          descriptor?.kinds.find((kind) => kind.id === item.row.entryRef.kindId)?.workflowSubject ?? null,
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
      title: (item) => item.row.title,
      // The table says the designation quietly after the title ("Retry … #2481") and Where is the place alone.
      titleSuffix: (item) => item.row.designation,
      where: (item) => <TriageRowWhere pluginId={item.row.entryRef.source.pluginId} label={readTriageRowPlaceV1(item.row)} />,
      // The list has room for both, and for who opened it ("tidewater/payments-api #2481 · Mara Oduya").
      byline: (item) => {
        const { row } = item;
        const where = row.designation === null ? readTriageRowPlaceV1(row) : `${row.scopeLabel} ${row.designation}`;
        return (
          <TriageRowWhere
            pluginId={row.entryRef.source.pluginId}
            label={row.authorLabel === null ? where : `${where} · ${row.authorLabel}`}
          />
        );
      },
      reason: (item) => {
        const { row } = item;
        if (row.detail === null || row.detailKind === 'summary') return null;
        // One tone owner for the trailing detail: needs-you in the attention ink (blue stays for focus and links).
        const tone: TextTone = readTriageRowDetailToneV1(row) ?? 'secondary';
        // The row's one loud fact is a tinted chip led by its reason's mark; a quiet note ("Waiting on Priya")
        // stays plain words.
        if (tone === 'secondary') return <Text variant="body" tone={tone} value={row.detail} numberOfLines={1} />;
        const icon = row.detailIcon !== null && isHappierIconName(row.detailIcon) ? row.detailIcon : undefined;
        return <Badge variant="tinted" tone={tone} value={row.detail} {...(icon === undefined ? {} : { icon })} />;
      },
      ...(withSignal ? {
        signal: (item: TriageListItemV1) => (item.signal === null ? null : (
          <TriageCellState mark={readTriageSignalCellMarkV1(item.signal.tone)} label={item.signal.label} />
        )),
      } : {}),
      agent: (item) => (item.agent === null ? null : (
        <TriageCellState
          mark={readTriageAgentCellMarkV1(item.agent)}
          label={text(item.agent.labelKey, item.agent.label, item.agent.labelParams)}
          {...(item.agent.agent?.brand === undefined ? {} : { brandPluginId: item.agent.agent.brand.pluginId })}
        />
      )),
      age: (item) => (item.row.activityAtMs === null
        ? null
        : formatTriageCompactAgeV1(surfaceContext.locale, item.row.activityAtMs, Date.now())),
      peek: (item) => <TriageListPeek item={item} />,
      accessibilityLabel: (item) => item.row.title,
      accessibilityHint: (item) => triageListRowItemProps(item.row, false, {
        nowMs: Date.now(),
        locale: surfaceContext.locale,
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
        title: text('plugins.triage.surface.column.entry', 'Entry'),
        where: text('plugins.triage.surface.column.where', 'Where'),
        reason: text('plugins.triage.surface.column.reason', 'Why it’s here'),
        signal: text('plugins.triage.surface.column.signal', 'Signal'),
        agent: text('plugins.triage.surface.column.agent', 'Agent'),
        age: text('plugins.triage.surface.column.age', 'Age'),
      },
    };
  }, [organizing, surfaceContext, text, withSignal]);
}
