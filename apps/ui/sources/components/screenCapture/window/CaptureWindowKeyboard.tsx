import * as React from 'react';

import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';

const NO_ROOT_HANDLERS = {};

/** Auxiliary windows boot without the app shell, so the Capture window hosts the one keyboard owner itself. */
export function CaptureWindowKeyboard(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <KeyboardShortcutProvider handlers={NO_ROOT_HANDLERS}>
            {props.children}
        </KeyboardShortcutProvider>
    );
}
