import type { PlatformOSType } from 'react-native';

/**
 * Canonical visibility policy for transcript row actions (copy / select / fork /
 * rollback / pin / open-details). One owner for every surface that reveals a row
 * action, so a single row cannot end up with two competing reveal rules.
 *
 * Fine-pointer web hides the actions until the row (its actions included) is
 * hovered, or keyboard focus enters the action group. Touch hosts (native, and
 * web whose PRIMARY pointer is coarse) have no hover: a row that can be opened
 * by tap or long-press (a message; `touchOpened` is set) shows its actions only
 * while it is opened, and a row without that gesture (a tool row) keeps them
 * visible.
 */
export type TranscriptRowActionVisibilityInput = Readonly<{
    platformOS: PlatformOSType;
    isRowHovered: boolean;
    isRowFocused?: boolean;
    coarsePrimaryPointer?: boolean;
    selectionModeActive?: boolean;
    /** Touch only: whether this row is opened by tap or long-press. Undefined: the row has no such gesture. */
    touchOpened?: boolean;
    /** Pinned rows keep their pin visible without revealing the rest of the row. */
    pinned?: boolean;
}>;

export function shouldShowTranscriptRowActions(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.selectionModeActive === true) return true;
    if (input.platformOS !== 'web' || input.coarsePrimaryPointer === true) {
        return input.touchOpened === undefined || input.touchOpened || input.isRowFocused === true;
    }
    return input.isRowHovered || input.isRowFocused === true;
}

export function shouldShowTranscriptRowPinAction(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.pinned === true) return true;
    return shouldShowTranscriptRowActions(input);
}
