import { describe, expect, it } from 'vitest';
import { SESSION_ACTION_RENAME_ID, SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from './sessionActionIds';
import { resolveSessionAppearanceColorMenuSelection } from '@/components/sessions/organization/sessionAppearanceColorMenu';
import { buildSessionMenuCommands } from './sessionMenuCommands';
import { SESSION_COPY_ID_MENU_ITEM_ID, SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID } from '@/components/sessions/debug/sessionDebugClipboard';

describe('Session menu commands', () => {
    it('exposes the color picker root and keeps choices inside its presenter', async () => {
        let selected: unknown;
        const commands = buildSessionMenuCommands({ items: [{
            id: SESSION_ACTION_SET_APPEARANCE_COLOR_ID, title: 'Set color',
            submenu: { items: [{ id: `${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:accent:blue`, title: 'Blue' }] },
        }], select: id => { selected = resolveSessionAppearanceColorMenuSelection(SESSION_ACTION_SET_APPEARANCE_COLOR_ID, id); } });
        const picker = commands.find(command => command.key === `session.action:${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}`);
        expect(commands.map(command => command.key)).toEqual([`session.action:${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}`]);
        expect(picker).toBeDefined();
        await picker!.invoke(undefined, { surface: 'ui' }, { execute: async () => ({ ok: true, result: null }) });
        expect(selected).toEqual({ kind: 'custom' });
    });
    it('exposes registered enabled operations through the existing selection owner', async () => {
        let selected: string | null = null;
        const commands = buildSessionMenuCommands({
            items: [
                { id: SESSION_ACTION_RENAME_ID, title: 'Rename Session' },
                { id: 'copy', title: 'Copy', submenu: { items: [
                    { id: SESSION_COPY_ID_MENU_ITEM_ID, title: 'Session ID' },
                    { id: SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID, title: 'Provider ID', disabled: true },
                    { id: 'incidental-choice', title: 'Choice' },
                ] } },
            ],
            select: id => { selected = id; },
        });
        expect(commands.map(command => command.key)).toEqual([
            `session.action:${SESSION_ACTION_RENAME_ID}`, `session.action:${SESSION_COPY_ID_MENU_ITEM_ID}`,
        ]);
        expect(commands[1]!.title).toBe('Copy · Session ID');
        await commands[1]!.invoke(undefined, { surface: 'ui' }, { execute: async () => ({ ok: true, result: null }) });
        expect(selected).toBe(SESSION_COPY_ID_MENU_ITEM_ID);
    });
});
