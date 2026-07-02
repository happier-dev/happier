import { describe, expect, it } from 'vitest';

import { defaultKeyboardCommands } from './commands';

const sessionListSelectionCommandIds = [
    'sessions.selection.toggleFocused',
    'sessions.selection.extendUp',
    'sessions.selection.extendDown',
    'sessions.selection.selectAll',
    'sessions.selection.clear',
] as const;

function commandBindings(commandId: string) {
    const command = defaultKeyboardCommands.find((candidate) => candidate.id === commandId);
    return command?.defaultBindings ?? (command?.defaultBinding ? [command.defaultBinding] : []);
}

describe('session-list selection keyboard commands', () => {
    it('uses a dedicated conflict scope so selection never clobbers split-canvas navigation', () => {
        for (const commandId of sessionListSelectionCommandIds) {
            const bindings = commandBindings(commandId);
            expect(bindings.length, `${commandId} should define a default binding`).toBeGreaterThan(0);
            expect(bindings.every((binding) => binding.conflictScope === 'sessionListSelection'), commandId).toBe(true);
        }
    });

    it('does not reuse split-canvas or visible-session Alt+Arrow defaults', () => {
        const reservedBindings = new Set([
            'Alt+ArrowDown',
            'Alt+ArrowLeft',
            'Alt+ArrowRight',
            'Alt+ArrowUp',
            'Alt+Shift+ArrowDown',
            'Alt+Shift+ArrowUp',
        ]);

        for (const commandId of sessionListSelectionCommandIds) {
            for (const binding of commandBindings(commandId)) {
                expect(reservedBindings.has(binding.binding), `${commandId} should not use ${binding.binding}`).toBe(false);
            }
        }
    });
});
