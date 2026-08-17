import * as React from 'react';
import { Button, List } from '@happier-dev/plugin-ui';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';

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

export function TriageListRow(props: Readonly<{
  row: TriageListDisplayRowV1;
  handlers: TriageRowPinHandlersV1;
}>): React.ReactElement {
  const { row, handlers } = props;
  const busy = handlers.busyKey === row.key;
  const disabled = handlers.unavailableReason !== null;
  const label = row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`;
  const onSetPinned = React.useCallback(() => { handlers.onSetPinned(row); }, [handlers, row]);

  const common = {
    title: row.title,
    subtitle: row.scopeLabel,
    ...(row.detail === null ? {} : { detail: row.detail }),
    tone: row.tone,
    busy,
    // The row's accessible NAME is the entry, not the concatenation of every
    // word inside it. Without this the shared `Item` composes its name from its
    // text descendants, so an option announced — and addressed — as
    // "Replace the duplicated normalizerexample/repository", with no separator
    // between the title and the scope. The remaining `core/SURFACE.md` §7.1
    // announcement facts (kind, lifecycle, freshness, section-local position)
    // need a description/hint slot the shared `Item` does not publish; they are
    // deliberately not smuggled into the name, because a name that grows a
    // sentence is a name no assistive technology can be pointed at.
    accessibilityLabel: row.title,
  } as const;

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
      secondaryActionAccessibilityLabel={`More actions for ${row.title}`}
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
