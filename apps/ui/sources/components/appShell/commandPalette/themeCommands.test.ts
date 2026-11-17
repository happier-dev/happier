import { describe, expect, it } from 'vitest';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeActionRequest } from '@happier-dev/protocol/actions/themeActionFamily';
import { createThemeActionHarness, themeActionDocument } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { buildThemeCommands } from './themeCommands';
import { buildCommandPaletteSelectionListSections, readCommandPaletteOptionCommand } from './buildCommandPaletteSelectionListSections';

describe('theme palette commands', () => {
    it('does no theme read until the shared nested group resolves and retains child activation', async () => {
        let reads = 0;
        const child = { id: 'theme.base', title: 'Built-in', action: async () => {} };
        const commands = [{ id: 'theme.change', title: 'Change theme', action: () => {},
            loadCommands: async () => { reads++; return [child]; } }];
        const sections = buildCommandPaletteSelectionListSections(commands);
        expect(reads).toBe(0);
        const section = sections[0]!;
        if (section.kind !== 'static') throw new Error('Expected the command section');
        const nested = section.options[0]!.openStep!.sections[0]!;
        if (nested.kind !== 'dynamic') throw new Error('Expected a lazy theme section');
        const result = await nested.resolve('', new AbortController().signal);
        expect(reads).toBe(1);
        expect(readCommandPaletteOptionCommand(result.options[0]!)).toBe(child);
    });
    it('applies headers and undoes through the same library operation without saving a theme', async () => {
        const harness = createThemeActionHarness();
        await harness.library.save({ document: themeActionDocument('00000000-0000-4000-8000-000000000019') });
        const executeTheme = createThemeActionExecute({ withLibrary: operation => operation(harness.library),
            clientId: () => 'this-client', readSelection: () => harness.selection });
        const execute = async (actionId: ThemeActionRequest['actionId'], input: unknown) => {
            const result = await executeTheme({ actionId, input, context: { surface: 'ui' } } as ThemeActionRequest);
            if ('errorCode' in result) throw new Error(result.errorCode);
        };
        const read = async () => buildThemeCommands({ entries: await harness.library.list(), mode: 'light',
            selection: harness.selection, undoHandle: harness.library.lastUndo(), execute, push: () => {} });
        const before = await read();
        expect(before.some(command => command.actionSpecId === THEME_ACTION_IDS.undo)).toBe(false);
        const saved = before.find(command => command.id.includes('00000000-0000-4000-8000-000000000019'))!;
        expect(saved.mark).toMatchObject({ kind: 'theme' });
        const writes = harness.writes();
        await saved.action();
        expect(harness.selection.light).toEqual({ kind: 'artifact', id: '00000000-0000-4000-8000-000000000019' });
        const commands = await read();
        expect(commands.some(command => command.id === 'theme.base')).toBe(true);
        await commands.find(command => command.actionSpecId === THEME_ACTION_IDS.undo)!.action();
        expect(harness.selection.light).toBeNull();
        expect(harness.writes()).toBe(writes);
        expect((await read()).some(command => command.actionSpecId === THEME_ACTION_IDS.undo)).toBe(false);
    });
});
