import * as React from 'react';
import {
  Button,
  List,
  useListMultiSelectionRow,
  usePluginTranslation,
  type ListItemProps,
} from '@happier-dev/plugin-ui';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageListContinuationCopyV1 } from './continuation.js';
import type { TriageListSectionItemV1 } from './sections.js';

/**
 * One list row.
 *
 * It is the shared `List.Item`, not a Triage row component: activation,
 * selection semantics, keyboard behavior, focus registration, target size and
 * divider are all owned there and reached through the sectioned `List` that
 * mounts this renderer (`core/SURFACE.md` §1.2). The only things this file
 * decides are which already-projected words go in which slot, and which single
 * Pin/Unpin affordance the row carries.
 *
 * There is exactly one such affordance per row, and it is never two states of
 * two controls. A materialized row offers it through the public secondary-action
 * owner, which keeps the overflow outside the row press target and owns the
 * menu's focus and keyboard behavior. A pinned row this mount never materialized
 * carries an inline **Unpin** instead, because it has no detail panel to host
 * the operation and dropping it would strand a pin the reader cannot remove.
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
 * The description is the row's own already-projected words in the order it
 * shows them — the owning scope, then the quiet trailing line that says why the
 * entry needs the reader or why it cannot currently be shown
 * (`ui/window/entryDisplay.ts`). Nothing is composed here that the row does not
 * already display, and the title is never repeated: an entry that announced
 * itself twice is the failure the pinned name exists to prevent. Both are V1
 * protocol strings, which are bounded, single-line and non-empty, so there is
 * no empty part to guard against.
 *
 * `, ` is the separator the platforms this description reaches compose their
 * own multi-part announcements with; it is punctuation, not copy.
 */
export function triageListRowItemProps(
  row: TriageListDisplayRowV1,
  busy: boolean,
): Pick<
  ListItemProps,
  | 'testID'
  | 'title'
  | 'subtitle'
  | 'detail'
  | 'titleNumberOfLines'
  | 'subtitleNumberOfLines'
  | 'detailNumberOfLines'
  | 'tone'
  | 'busy'
  | 'accessibilityLabel'
  | 'accessibilityHint'
> {
  return {
    testID: triageListRowTestId(row.key),
    title: row.title,
    subtitle: row.scopeLabel,
    ...(row.detail === null ? {} : { detail: row.detail }),
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
    tone: row.tone,
    busy,
    accessibilityLabel: row.title,
    accessibilityHint: row.detail === null
      ? row.scopeLabel
      : `${row.scopeLabel}, ${row.detail}`,
  };
}

export function TriageListRow(props: Readonly<{
  row: TriageListDisplayRowV1;
  handlers: TriageRowPinHandlersV1;
}>): React.ReactElement {
  const { row, handlers } = props;
  const busy = handlers.busyKey === row.key;
  const disabled = handlers.unavailableReason !== null;
  // `{title}` interpolation is why these cannot go through `secondaryActions[].labelKey`
  // or `accessibilityHintKey`: those resolve through `resolveAuthorText` WITHOUT a
  // values argument, so a placeholder would reach the reader verbatim.
  const text = usePluginTranslation();
  const label = readTriagePinActionLabelV1(row, text);
  const onSetPinned = React.useCallback(() => { handlers.onSetPinned(row); }, [handlers, row]);
  // The shared selection owner's own per-row facts, subscribed per row: the
  // three-character primitive commits this row and the row that lost the
  // anchor, not every mounted cell.
  const selection = useListMultiSelectionRow(row.key);
  const selectLabel = selection.isSelected
    ? text('plugins.triage.surface.row.deselect', 'Deselect {title}', { title: row.title })
    : text('plugins.triage.surface.row.select', 'Select {title}', { title: row.title });
  const onSecondaryAction = React.useCallback((actionId: string) => {
    // `enter` rather than `toggle` for the first row: turning selection mode on
    // AND choosing the row the reader pressed is one gesture, and entering an
    // empty selection mode would make the bar appear with nothing in it.
    if (actionId === TRIAGE_ROW_SELECT_ACTION_ID_V1) {
      if (selection.isSelectionMode) selection.toggle();
      else selection.replace();
      return;
    }
    handlers.onSetPinned(row);
  }, [handlers, row, selection]);

  const common = triageListRowItemProps(row, busy);

  if (!row.materialized) {
    return (
      <List.Item
        {...common}
        accessoryOutsidePressable
        accessory={(
          <Button
            title={label}
            variant="plain"
            busy={busy}
            disabled={disabled}
            onPress={onSetPinned}
          />
        )}
      />
    );
  }

  return (
    <List.Item
      {...common}
      secondaryActions={triageListRowSecondaryActionsV1({
        selectLabel,
        pinLabel: label,
        pinDisabled: disabled,
      })}
      // Kept as an explicit override rather than falling back to plugin-ui's
      // default: that default resolves `happier.plugin-ui.list.moreActions`
      // against the MOUNTED plugin's catalog, which Triage does not declare, so
      // dropping this would degrade to English rather than inherit a translation.
      secondaryActionAccessibilityLabel={text(
        'plugins.triage.surface.row.moreActions',
        'More actions for {title}',
        { title: row.title },
      )}
      onSecondaryAction={onSecondaryAction}
    />
  );
}

/** The row renderer the sectioned `List` calls; its signature is `List`'s own. */
export function renderTriageListRow(
  row: TriageListDisplayRowV1,
  handlers: TriageRowPinHandlersV1,
): React.ReactElement {
  return <TriageListRow row={row} handlers={handlers} />;
}

/**
 * A section's last row when its walk is not finished (`core/SURFACE.md` §4.2).
 *
 * It is the same shared `List.Item` every other row is, so it occupies one
 * position in the flattened traversal order and is announced with the same
 * section-local position as its neighbours — which is the whole reason the
 * design chose a stated row over an invisible scroll trigger.
 *
 * It carries no Pin/Unpin affordance and it names no entry, so it takes part in
 * neither selection nor the reducer's visible order. What it does carry now is
 * the section's own continuation control, and it is an `accessory` rather than
 * a row press for exactly that reason: pressing the ROW is how an entry is
 * opened, and a row with no entry must not be the thing that gets selected. The
 * control is the same public `Button` the unmaterialized pinned row uses, so
 * focus, keyboard activation and the busy state are owned there.
 *
 * Whether there is a control at all is not decided here. The copy owner
 * (`ui/list/continuation.ts`) supplies a label exactly when pressing would read
 * more, so an exhausted, ceilinged or not-yet-mounted section renders the
 * statement alone rather than a control that would do nothing.
 *
 * Its statement is the description, not the heading, so it is what the row's
 * accessible description carries. A name pinned to the heading alone announced
 * "More entries may exist" and then withheld the sentence that says why — the
 * exact silence a stated row was chosen over a scroll trigger to avoid.
 */
export function TriageListContinuationRow(props: Readonly<{
  copy: TriageListContinuationCopyV1;
  onLoadMore: () => void;
}>): React.ReactElement {
  const { copy, onLoadMore } = props;
  return (
    <List.Item
      title={copy.title}
      subtitle={copy.description}
      tone={copy.tone}
      accessibilityLabel={copy.title}
      accessibilityHint={copy.description}
      {...(copy.actionLabel === undefined ? {} : {
        accessory: (
          <Button
            title={copy.actionLabel}
            variant="plain"
            busy={copy.busy}
            onPress={onLoadMore}
          />
        ),
      })}
    />
  );
}

/**
 * The key the shared `List` addresses a section item by.
 *
 * A module constant, not an inline lambda, for the same reason `RETAIN_EVERY_ROW`
 * is: `List` memoizes its flattened traversal order, its key index and its
 * roving-entry array on this identity. A new function each render reprojects the
 * WHOLE dataset — every section, every row, every index — on every render the
 * shell does, including the ones a focus move causes. At two thousand rows that
 * is the difference between moving a cursor and rebuilding the collection.
 */
export function readTriageListSectionItemKey(item: TriageListSectionItemV1): string {
  return item.key;
}

/**
 * One stable row renderer for the shared `List`.
 *
 * `List` holds the renderer behind a `useCallback` whose dependency list
 * includes it, so an inline lambda invalidates the memoized row projection and
 * forces the virtualizer to rebuild every mounted cell on every shell render.
 * Binding it to the three things a row actually depends on — the translated
 * continuation copy, the continuation demand and the Pin/Unpin handlers — keeps
 * focus movement local.
 */
export function useTriageListRowRenderer(input: Readonly<{
  continuationCopy: (sectionKey: string | null) => TriageListContinuationCopyV1;
  /** The section's own continuation demand; the lanes and the pins page differently. */
  onLoadMore: (sectionKey: string | null) => void;
  handlers: TriageRowPinHandlersV1;
}>): (item: TriageListSectionItemV1, index: number, sectionKey: string | null) => React.ReactElement {
  const { continuationCopy, onLoadMore, handlers } = input;
  return React.useCallback(
    (item: TriageListSectionItemV1, _index: number, sectionKey: string | null) => (
      item.kind === 'continuation'
        ? (
          <TriageListContinuationRow
            copy={continuationCopy(sectionKey)}
            onLoadMore={() => { onLoadMore(sectionKey); }}
          />
        )
        : <TriageListRow row={item.row} handlers={handlers} />
    ),
    [continuationCopy, handlers, onLoadMore],
  );
}
