import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutLabelsContext, useKeyboardShortcutLabel } from './shortcutLabels';
import type { KeyboardCommandId } from './types';

describe('shortcut label subscriptions', () => {
    it('updates a bound label without subscribing controls that have no command', async () => {
        const renders = { bound: 0, unbound: 0 };
        const labels: string[] = [];
        function Probe(props: { kind: keyof typeof renders; commandId?: KeyboardCommandId }) {
            const label = useKeyboardShortcutLabel(props.commandId);
            renders[props.kind] += 1;
            if (label) labels.push(label);
            return null;
        }
        const children = <><Probe kind="bound" commandId="commandPalette.open" /><Probe kind="unbound" /></>;
        const content = (binding: string) => <KeyboardShortcutLabelsContext.Provider value={{ 'commandPalette.open': binding }}>{children}</KeyboardShortcutLabelsContext.Provider>;
        const screen = await renderScreen(content('Ctrl+K'));
        try {
            expect(renders).toEqual({ bound: 1, unbound: 1 });
            await screen.update(content('Ctrl+J'));
            expect(labels).toEqual(['Ctrl+K', 'Ctrl+J']);
            expect(renders).toEqual({ bound: 2, unbound: 1 });
        } finally { await screen.unmount(); }
    });
});
