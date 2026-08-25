import {
    resolveHappierListMultiSelectionPointerAction,
    type HappierListMultiSelectionPointerAction,
} from '@happier-dev/plugin-ui/presentation';

import type { KeyboardPlatform } from '@/keyboard/types';

export type SessionListSelectionPointerAction = HappierListMultiSelectionPointerAction;

/**
 * `KeyboardPlatform` is the same closed vocabulary the collection owner's
 * `HappierPointerPlatform` uses, so it is passed through unchanged rather than
 * mapped: a mapping table would be a second place for the Apple/non-Apple
 * command-modifier rule to disagree with itself.
 */
export type SessionListSelectionPointerInput = Readonly<{
    isSelectionMode: boolean;
    platform: KeyboardPlatform;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}>;

export function resolveSessionListSelectionPointerAction(
    input: SessionListSelectionPointerInput,
): SessionListSelectionPointerAction {
    return resolveHappierListMultiSelectionPointerAction(input);
}
