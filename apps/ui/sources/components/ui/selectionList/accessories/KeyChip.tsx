import * as React from 'react';

import { KeyHint } from '@/components/ui/keyboard/KeyHint';

export type KeyChipProps = Readonly<{
    label: string;
    /** Decorative chrome — when false (no hardware keyboard) the chip renders nothing. */
    enabled?: boolean;
    testID?: string;
}>;

/**
 * Decorative key-hint chip rendered next to a row or footer hint description.
 * NOT tappable — keys live in the user's hardware keyboard, not in the chip.
 *
 * Uses a 4px corner radius (concentric with the row's effective inner radius
 * given the row's padding); the row owns the press feedback via `Item`'s
 * built-in `surfacePressed` background tint, so KeyChip stays purely visual.
 */
export function KeyChip(props: KeyChipProps): React.ReactElement | null {
    return <KeyHint label={props.label} enabled={props.enabled} testID={props.testID} />;
}
