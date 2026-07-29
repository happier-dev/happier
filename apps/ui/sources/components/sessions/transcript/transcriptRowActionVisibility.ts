import type { PlatformOSType } from 'react-native';

/**
 * Canonical visibility policy for transcript row actions (copy / select / fork /
 * rollback / pin / open-details). One owner for every surface that reveals a row
 * action, so a single row cannot end up with two competing reveal rules.
 *
 * Fine-pointer web hides the actions until the row is hovered, an action is
 * hovered, or keyboard focus enters the action group. Touch platforms and web
 * hosts whose PRIMARY pointer is coarse have no hover, so the actions stay
 * visible there.
 */
export type TranscriptRowActionVisibilityInput = Readonly<{
    platformOS: PlatformOSType;
    isRowHovered: boolean;
    isActionHovered: boolean;
    isRowFocused?: boolean;
    coarsePrimaryPointer?: boolean;
    selectionModeActive?: boolean;
    /** Pinned rows keep their pin visible without revealing the rest of the row. */
    pinned?: boolean;
}>;

export function shouldShowTranscriptRowActions(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.selectionModeActive === true) return true;
    if (input.platformOS !== 'web') return true;
    if (input.coarsePrimaryPointer === true) return true;
    return input.isRowHovered || input.isActionHovered || input.isRowFocused === true;
}

export function shouldShowTranscriptRowPinAction(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.pinned === true) return true;
    return shouldShowTranscriptRowActions(input);
}
