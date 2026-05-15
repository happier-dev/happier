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
});
