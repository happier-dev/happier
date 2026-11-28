import * as React from 'react';

import { useKeyboardShortcutContextSnapshot } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardCommandControls } from './buildCommandPaletteCommands';

/** The palette host reads the one keyboard runtime created beneath it. */
export function KeyboardCommandPaletteBridge(props: Readonly<{
    target: React.MutableRefObject<KeyboardCommandControls | null>;
}>): null {
    const { registration } = useKeyboardShortcutContextSnapshot();
    React.useLayoutEffect(() => {
        if (!registration) return;
        const controls = { isAvailable: registration.isCommandAvailable, execute: registration.executeCommand };
        props.target.current = controls;
        return () => { if (props.target.current === controls) props.target.current = null; };
    }, [props.target, registration]);
    return null;
}
