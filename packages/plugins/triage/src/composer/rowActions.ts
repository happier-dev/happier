import type { TriagePickerRowV1 } from './pickerModel.js';

/**
 * The two independent controls of one picker row (`core/COMPOSER.md` §2, §6).
 *
 * A row is a labelled group, not a button: Enter or Space on the row itself
 * does nothing, and only these two separately labelled controls commit an
 * effect. Their logical, render and focus order is always Attach/Remove then
 * View details. Physical placement mirrors under RTL; the order never does,
 * because mirroring keyboard and screen-reader order would make the same row
 * announce its actions backwards.
 */

export type TriageRowActionIdV1 = 'attachment' | 'viewDetails';

export type TriageRowActionDescriptorV1 =
    | Readonly<{ actionId: 'attachment'; intent: 'attach' | 'remove' | null; enabled: boolean }>
    | Readonly<{ actionId: 'viewDetails'; intent: 'open' | null; enabled: boolean }>;

/**
 * What each control commits, and whether it can run at all.
 *
 * The two `enabled` decisions are independent by construction: an entry no live
 * connection observes can neither be attached nor opened, while an entry already
 * in the draft stays removable even when its source is gone.
 */
export function describeTriageRowActions(
    row: TriagePickerRowV1,
): readonly [TriageRowActionDescriptorV1, TriageRowActionDescriptorV1] {
    const mutation = row.mutation;
    return [
        mutation.kind === 'unavailable'
            ? { actionId: 'attachment', intent: null, enabled: false }
            : { actionId: 'attachment', intent: mutation.kind, enabled: true },
        row.viewDetails.kind === 'open'
            ? { actionId: 'viewDetails', intent: 'open', enabled: true }
            : { actionId: 'viewDetails', intent: null, enabled: false },
    ];
}
