import * as React from 'react';
import { Button, List, usePluginTranslation, type ListItemProps } from '@happier-dev/plugin-ui';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
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
  'testID' | 'title' | 'subtitle' | 'detail' | 'tone' | 'busy' | 'accessibilityLabel' | 'accessibilityHint'
> {
  return {
    testID: triageListRowTestId(row.key),
    title: row.title,
    subtitle: row.scopeLabel,
    ...(row.detail === null ? {} : { detail: row.detail }),
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
  const label = row.pinned
    ? text('plugins.triage.surface.row.unpin', 'Unpin {title}', { title: row.title })
    : text('plugins.triage.surface.row.pin', 'Pin {title}', { title: row.title });
  const onSetPinned = React.useCallback(() => { handlers.onSetPinned(row); }, [handlers, row]);

  const common = triageListRowItemProps(row, busy);

  if (!row.materialized) {
    return (
      <List.Item
        {...common}
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
      secondaryActions={[{ id: PIN_ACTION_ID, label, disabled }]}
      // Kept as an explicit override rather than falling back to plugin-ui's
      // default: that default resolves `happier.plugin-ui.list.moreActions`
      // against the MOUNTED plugin's catalog, which Triage does not declare, so
      // dropping this would degrade to English rather than inherit a translation.
      secondaryActionAccessibilityLabel={text(
        'plugins.triage.surface.row.moreActions',
        'More actions for {title}',
        { title: row.title },
      )}
      onSecondaryAction={onSetPinned}
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
 * design chose a stated row over an invisible scroll trigger. It carries no
 * Pin/Unpin affordance and no press handler: it names no entry, and there is
 * no per-section continuation operation for it to invoke. Its copy therefore
 * offers no way to load more either — **Refresh** re-reads the same first page
 * at the same bound, so implying it can reach a further entry would make this
 * row a dead-end affordance instead of an honest statement.
 *
 * Its statement is the description, not the heading, so it is what the row's
 * accessible description carries. A name pinned to the heading alone announced
 * "More entries may exist" and then withheld the sentence that says why — the
 * exact silence a stated row was chosen over a scroll trigger to avoid.
 */
export function TriageListContinuationRow(props: Readonly<{
  title: string;
  description: string;
}>): React.ReactElement {
  return (
    <List.Item
      title={props.title}
      subtitle={props.description}
      tone="neutral"
      accessibilityLabel={props.title}
      accessibilityHint={props.description}
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

/** The copy a continuation row carries, which depends only on which section it ends. */
export type TriageListContinuationCopyV1 = Readonly<{ title: string; description: string }>;

/**
 * One stable row renderer for the shared `List`.
 *
 * `List` holds the renderer behind a `useCallback` whose dependency list
 * includes it, so an inline lambda invalidates the memoized row projection and
 * forces the virtualizer to rebuild every mounted cell on every shell render.
 * Binding it to the two things a row actually depends on — the translated
 * continuation copy and the Pin/Unpin handlers — keeps focus movement local.
 */
export function useTriageListRowRenderer(input: Readonly<{
  continuationCopy: (sectionKey: string | null) => TriageListContinuationCopyV1;
  handlers: TriageRowPinHandlersV1;
}>): (item: TriageListSectionItemV1, index: number, sectionKey: string | null) => React.ReactElement {
  const { continuationCopy, handlers } = input;
  return React.useCallback(
    (item: TriageListSectionItemV1, _index: number, sectionKey: string | null) => (
      item.kind === 'continuation'
        ? <TriageListContinuationRow {...continuationCopy(sectionKey)} />
        : <TriageListRow row={item.row} handlers={handlers} />
    ),
    [continuationCopy, handlers],
  );
}
