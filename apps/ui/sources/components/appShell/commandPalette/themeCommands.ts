import type { Command } from './types';
import type { ThemeLibraryEntry, ThemeProfileMode, ThemeReference, ThemeUndoHandle } from '@/theme/profiles/themeProfileTypes';
import type { ThemeActionId } from '@happier-dev/protocol/actions/themeActionFamily';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { t } from '@/text';
import { getThemePresetSourceReferenceId } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';

export type ThemeCommandInput = Readonly<{
    entries: readonly ThemeLibraryEntry[];
    mode: ThemeProfileMode;
    selection: Readonly<Record<ThemeProfileMode, ThemeReference | null>>;
    undoHandle: ThemeUndoHandle | null;
    execute(actionId: ThemeActionId, input: unknown): Promise<unknown>;
    push(path: string): void;
}>;

/** Header-only choices; selection and reversal stay with the ordinary theme Actions. */
export function buildThemeCommands(input: ThemeCommandInput): Command[] {
    const category = t('themePalette.change');
    const commands: Command[] = [];
    if (input.undoHandle) commands.push({ id: 'theme.undo', actionSpecId: THEME_ACTION_IDS.undo,
        title: t('themePalette.undo'), icon: 'arrow-counter-clockwise', category,
        action: async () => { await input.execute(THEME_ACTION_IDS.undo, { undoHandle: input.undoHandle }); } });
    commands.push({ id: 'theme.base', actionSpecId: THEME_ACTION_IDS.apply,
        title: t('settingsAppearance.themeProfiles.useBuiltInTheme'), icon: 'palette', category,
        action: async () => { await input.execute(THEME_ACTION_IDS.apply, { ref: null, mode: input.mode }); } });
    for (const entry of input.entries) {
        if (entry.mode !== input.mode) continue;
        const source = entry.source.kind;
        commands.push({ id: `theme:${getThemePresetSourceReferenceId(entry.reference)}`, actionSpecId: THEME_ACTION_IDS.apply,
            title: entry.name, subtitle: source === 'built-in' ? t('settingsAppearance.themeProfiles.builtInTheme')
                : source === 'store' ? t('settingsAppearance.themeProfiles.sourceStore')
                    : source === 'plugin' ? t('settingsAppearance.themeProfiles.sourcePlugin') : t('settingsAppearance.themeProfiles.sourceYours'),
            mark: { kind: 'theme', miniature: entry.miniature }, category,
            action: async () => { await input.execute(THEME_ACTION_IDS.apply, { ref: entry.reference, mode: input.mode }); } });
    }
    commands.push({ id: 'theme.library', title: t('themePalette.open'), icon: 'palette', category,
        action: () => input.push('/settings/appearance/themes') });
    const reference = input.selection[input.mode];
    const selected = input.entries.find(entry => sameStrictJsonValue(entry.reference, reference));
    const id = reference ? getThemePresetSourceReferenceId(reference) : input.mode;
    const path = selected?.editable ? `/settings/appearance/themes/${encodeURIComponent(id)}?view=css`
        : `/settings/appearance/themes/new?from=${encodeURIComponent(id)}&view=css`;
    commands.push({ id: 'theme.editCss', title: t('themePalette.editCss'), icon: 'code', category,
        action: () => input.push(path) });
    return commands;
}
