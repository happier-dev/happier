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

export type TriageRowActionLayoutInputV1 = Readonly<{
    /** Inline space the row has, after its own padding. */
    availableWidth: number;
    /** Already-scaled measured widths of the two action labels, in logical order. */
    actionWidths: readonly [number, number];
    /** Inline space the title/context must retain before an action may share its line. */
    titleMinimumWidth: number;
    /**
     * The host-resolved minimum interactive target size — 44 pt on iOS, 48 dp on
     * Android. It is a public platform contract, not a visual preference, so it
     * is the floor of both target dimensions rather than a nice-to-have.
     */
    minimumInteractiveTargetSize: number;
    gap: number;
    direction: 'ltr' | 'rtl';
}>;

export type TriageRowActionPlacementV1 = Readonly<{
    actionId: TriageRowActionIdV1;
    /** Logical/keyboard/screen-reader position. Never mirrored. */
    order: 0 | 1;
    width: number;
    height: number;
}>;

export type TriageRowActionLayoutV1 = Readonly<{
    /**
     * `inline` keeps both actions on the title's trailing line, `wrapped` moves
     * them to their own line beneath it, and `stacked` gives each its own line
     * when one line cannot hold both.
     */
    arrangement: 'inline' | 'wrapped' | 'stacked';
    /** Where the action line hangs physically; the only thing RTL mirrors. */
    physicalAlignment: 'left' | 'right';
    actions: readonly [TriageRowActionPlacementV1, TriageRowActionPlacementV1];
    titleWidth: number;
}>;

export type TriageRowActionDescriptorV1 =
    | Readonly<{ actionId: 'attachment'; intent: 'attach' | 'remove' | null; enabled: boolean }>
    | Readonly<{ actionId: 'viewDetails'; intent: 'open' | null; enabled: boolean }>;

export function resolveTriageRowActionLayout(
    input: TriageRowActionLayoutInputV1,
): TriageRowActionLayoutV1 {
    const { availableWidth, gap, minimumInteractiveTargetSize: floor } = input;
    const measured = [
        Math.max(input.actionWidths[0], floor),
        Math.max(input.actionWidths[1], floor),
    ] as const;
    const actionsLineWidth = measured[0] + gap + measured[1];

    const fitsBesideTitle = input.titleMinimumWidth + gap + actionsLineWidth <= availableWidth;
    const fitsOnOneLine = actionsLineWidth <= availableWidth;

    const arrangement: TriageRowActionLayoutV1['arrangement'] = fitsBesideTitle
        ? 'inline'
        : fitsOnOneLine ? 'wrapped' : 'stacked';

    // A stacked action owns its whole line; anything narrower than the platform
    // floor is raised to it in both dimensions.
    const widths = arrangement === 'stacked'
        ? [Math.max(availableWidth, floor), Math.max(availableWidth, floor)] as const
        : measured;

    return {
        arrangement,
        physicalAlignment: input.direction === 'rtl' ? 'left' : 'right',
        actions: [
            { actionId: 'attachment', order: 0, width: widths[0], height: floor },
            { actionId: 'viewDetails', order: 1, width: widths[1], height: floor },
        ],
        // The title has first claim: inline it keeps everything the actions do
        // not need, and otherwise it keeps the whole row rather than shrinking.
        titleWidth: arrangement === 'inline' ? availableWidth - gap - actionsLineWidth : availableWidth,
    };
}

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
