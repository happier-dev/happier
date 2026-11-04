import * as React from 'react';

import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardCommandId } from '@/keyboard/types';

const NO_ROOT_HANDLERS = {};
/** Send retains its composer compatibility here; editor commands declare their own focused scope. */
const CAPTURE_WINDOW_COMMANDS: readonly KeyboardCommandId[] = ['composer.sendImmediate', 'composer.sendInterrupt'];

/** Auxiliary windows boot without the app shell, so the Capture window hosts the one keyboard owner itself. */
export function CaptureWindowKeyboard(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <KeyboardShortcutProvider handlers={NO_ROOT_HANDLERS} enabledWhenDisabledCommandIds={CAPTURE_WINDOW_COMMANDS}>
            {props.children}
        </KeyboardShortcutProvider>
    );
}
