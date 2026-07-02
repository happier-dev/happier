import { describe, expect, it } from 'vitest';

import { defaultKeyboardCommands } from './commands';

describe('session row keyboard commands', () => {
    it('registers row move commands outside editable targets', () => {
        const commands = new Map(defaultKeyboardCommands.map((command) => [command.id, command]));

        expect(commands.get('sessions.row.moveUp')?.defaultBinding).toMatchObject({ binding: 'Alt+Shift+ArrowUp' });
        expect(commands.get('sessions.row.moveDown')?.defaultBinding).toMatchObject({ binding: 'Alt+Shift+ArrowDown' });
        expect(commands.get('sessions.row.moveToFolder')?.defaultBinding).toMatchObject({ binding: 'Alt+Shift+F' });
        expect(commands.get('sessions.row.moveToWorkspaceRoot')?.defaultBinding).toMatchObject({ binding: 'Alt+Shift+R' });
        expect(commands.get('sessions.row.moveToFolder')?.when?.({
            isEditableTarget: false,
            isComposing: false,
        })).toBe(true);
        expect(commands.get('sessions.row.moveToFolder')?.when?.({
            isEditableTarget: true,
            isComposing: false,
        })).toBe(false);
    });

    it('registers session-list selection commands with an isolated conflict scope', () => {
        const commands = new Map(defaultKeyboardCommands.map((command) => [command.id, command]));

        expect(commands.get('sessions.selection.toggleFocused')?.defaultBinding).toMatchObject({
            binding: 'Space',
            conflictScope: 'sessionListSelection',
        });
        expect(commands.get('sessions.selection.extendUp')?.defaultBinding).toMatchObject({
            binding: 'Shift+ArrowUp',
            conflictScope: 'sessionListSelection',
        });
        expect(commands.get('sessions.selection.extendDown')?.defaultBinding).toMatchObject({
            binding: 'Shift+ArrowDown',
            conflictScope: 'sessionListSelection',
        });
        expect(commands.get('sessions.selection.selectAll')?.defaultBinding).toMatchObject({
            binding: 'Mod+A',
            conflictScope: 'sessionListSelection',
        });
        expect(commands.get('sessions.selection.clear')?.defaultBinding).toMatchObject({
            binding: 'Escape',
            conflictScope: 'sessionListSelection',
        });
        expect(commands.get('sessions.selection.selectAll')?.when?.({
            isEditableTarget: true,
            isComposing: false,
        })).toBe(false);
    });
});
