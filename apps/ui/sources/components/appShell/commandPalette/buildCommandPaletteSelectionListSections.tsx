import * as React from 'react';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';

import type { Command } from './types';
import { ThemeCommandMark } from '@/components/settings/appearance/ThemeModePreview';

/**
 * Presentation adapter between the canonical command catalog
 * (`buildCommandPaletteCommands`) and the canonical list owner
 * (`SelectionList`). It owns no command construction, availability, currentness,
 * or activation policy — only the mapping of an already-admitted command onto a
 * namespaced option row.
 */

const COMMAND_OPTION_ID_PREFIX = 'command:';

export function buildCommandPaletteOptionId(commandId: string): string {
    return `${COMMAND_OPTION_ID_PREFIX}${commandId}`;
}

const commandPresentation = Symbol('commandPresentation');
const commandActivation = Symbol('commandActivation');
type CommandOption = SelectionListOption & Readonly<{
    [commandPresentation]?: Readonly<Pick<Command, 'icon' | 'mark' | 'shortcut' | 'loadCommands'>>;
    [commandActivation]?: Command;
}>;

/** Nested rows carry the same command into Search's ordinary dismiss/activate path. */
export function readCommandPaletteOptionCommand(option: SelectionListOption): Command | null {
    return (option as CommandOption)[commandActivation] ?? null;
}

function buildOption(command: Command, previous?: SelectionListOption): CommandOption {
    const icon = command.icon;
    const shortcut = command.shortcut;
    const presentation = (previous as CommandOption | undefined)?.[commandPresentation];
    const themeMark = typeof command.mark === 'object' ? command.mark : null;
    if (previous && presentation && previous.label === command.title
        && previous.subtitle === (command.subtitle || undefined)
        && presentation.icon === icon && presentation.mark === command.mark && presentation.shortcut === shortcut
        && presentation.loadCommands === command.loadCommands) return previous;
    return {
        [commandPresentation]: { icon, mark: command.mark, shortcut, loadCommands: command.loadCommands },
        [commandActivation]: command,
        id: buildCommandPaletteOptionId(command.id),
        testID: `command-palette:option:${command.id}`,
        label: command.title,
        ...(command.subtitle ? { subtitle: command.subtitle } : {}),
        ...(command.mark === 'askHappier' ? { icon: () => <AskHappierMark size={ICON_SIZE.md} /> }
            : themeMark ? { icon: () => <ThemeCommandMark miniature={themeMark.miniature} /> }
            : icon ? { icon: () => <Icon name={icon} size={ICON_SIZE.md} /> } : {}),
        ...(shortcut ? { rightAccessory: () => <KeyHint label={shortcut} /> } : {}),
        ...(command.loadCommands ? { openStep: {
            id: `commands:${command.id}`, title: command.title, inputPlaceholder: command.title,
            sections: [{ kind: 'dynamic' as const, id: `commands:${command.id}:entries`,
                seedFromInput: () => '',
                resolve: async () => ({ options: (await command.loadCommands!()).map(child => buildOption(child)) }),
            }],
        } } : {}),
    } satisfies CommandOption;
}

/**
 * Groups commands into one static section per category, preserving the
 * catalog's own order both for categories (first appearance) and for the
 * commands inside them. Matching, ranking, selection, and keyboard behavior
 * stay with SelectionList.
 */
export function buildCommandPaletteSelectionListSections(
    commands: readonly Command[],
    previousSections?: readonly SelectionListSectionDescriptor[],
): ReadonlyArray<SelectionListSectionDescriptor> {
    const previousOptions = new Map(previousSections?.flatMap(section => section.kind === 'static'
        ? section.options.map(option => [option.id, option] as const) : []));
    const optionsByCategory = new Map<string, SelectionListOption[]>();
    for (const command of commands) {
        const option = buildOption(command, previousOptions.get(buildCommandPaletteOptionId(command.id)));
        // Uncategorized commands share one untitled leading section rather than
        // borrowing another category's heading.
        const category = command.category ?? '';
        const existing = optionsByCategory.get(category);
        if (existing) {
            existing.push(option);
            continue;
        }
        optionsByCategory.set(category, [option]);
    }
    const sections: SelectionListSectionDescriptor[] = [];
    for (const [category, options] of optionsByCategory) {
        // Match the grouping key: admitting another category must not re-key
        // an existing category and remount its unchanged commands.
        sections.push({
            kind: 'static',
            id: `commands:${category}`,
            ...(category ? { title: category } : {}),
            options,
        });
    }
    return sections;
}
