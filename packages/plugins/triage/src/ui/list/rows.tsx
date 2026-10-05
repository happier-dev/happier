import * as React from 'react';
import {
  Button,
  DragSource,
  DropTarget,
  Icon,
  Row,
  Stack,
  Text,
  useListMultiSelectionRow,
  usePluginTranslation,
  useSurfaceContext,
  type CollectionAnatomy,
  type CollectionRowActions,
  type IconName,
  type ListItemProps,
  type TextTone,
} from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageSourceDescriptorV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageSourceDescriptorV1 } from '../detail/sourceSurface.js';
import {
  readTriageEntryRowAnnouncementV1,
  readTriageEntryRowContextV1,
  type TriageEntryDisplayTextV1,
} from '../window/entryDisplay.js';
import type { TriageListItemV1 } from './sections.js';
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
    : row.detailKind === 'attention' ? 'accent' : 'secondary';
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
 * The colour of the trailing detail. A required-attention reason is the row's
 * one loud fact and a presence problem keeps its caution; a suggestion, a
 * summary or a neutral note stays quiet. The title itself is never toned, so a
 * stale or dropped row still reads as a row (`DESIGN-SPEC` §5.5).
 */
export function readTriageRowDetailToneV1(
  row: Pick<TriageListDisplayRowV1, 'detail' | 'detailKind' | 'tone'>,
): TextTone | undefined {
  if (row.detail === null) return undefined;
  if (row.detailKind === 'attention') return 'accent';
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

/** The peek: the source's own summary, what the row already knows, and the two things a reader does next. */
function TriageListPeek(props: Readonly<{ item: TriageListItemV1 }>): React.ReactElement {
  const { row, summary } = props.item;
  const { handlers, onOpen } = useTriageListRowEnvironment();
  const text = usePluginTranslation();
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
            onPress={() => { onOpen(row.key); }}
          />
        )}
        <Button
          title={row.pinned
            ? text('plugins.triage.surface.row.unpinShort', 'Unpin')
            : text('plugins.triage.surface.peek.pin', 'Pin')}
          accessibilityLabel={readTriagePinActionLabelV1(row, text)}
          variant="secondary"
          busy={handlers.busyKey === row.key}
          disabled={handlers.unavailableReason !== null}
          onPress={() => { handlers.onSetPinned(row); }}
        />
      </Row>
    </Stack>
  );
}

const SIGNAL_TONES: Readonly<Record<NonNullable<TriageListItemV1['signal']>['tone'], TextTone>> = Object.freeze({
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  neutral: 'secondary',
});

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
      title: (item) => item.row.title,
      where: (item) => item.row.identifierLabel ?? item.row.scopeLabel,
      reason: (item) => {
        const { row } = item;
        if (row.detail === null || row.detailKind === 'summary') return null;
        const tone: TextTone = row.detailKind === 'attention'
          ? 'accent'
          : row.detailKind === 'presence' && row.tone !== 'neutral' ? row.tone : 'secondary';
        return <Text variant="caption" tone={tone} value={row.detail} numberOfLines={1} />;
      },
      ...(withSignal ? {
        signal: (item: TriageListItemV1) => (item.signal === null ? null : (
          <Text variant="caption" tone={SIGNAL_TONES[item.signal.tone]} value={item.signal.label} numberOfLines={1} />
        )),
      } : {}),
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
      }).accessibilityHint,
      testID: (item) => triageListRowTestId(item.row.key),
      columnTitles: {
        title: text('plugins.triage.surface.column.entry', 'Entry'),
        where: text('plugins.triage.surface.column.where', 'Where'),
        reason: text('plugins.triage.surface.column.reason', 'Why it’s here'),
        signal: text('plugins.triage.surface.column.signal', 'Signal'),
        age: text('plugins.triage.surface.column.age', 'Age'),
      },
    };
  }, [organizing, surfaceContext, text, withSignal]);
}
