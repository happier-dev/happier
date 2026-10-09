import * as React from 'react';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';

import type { Command } from './types';

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

function buildOption(command: Command): SelectionListOption {
    const icon = command.icon;
    const shortcut = command.shortcut;
    return {
        id: buildCommandPaletteOptionId(command.id),
        testID: `command-palette:option:${command.id}`,
        label: command.title,
        ...(command.subtitle ? { subtitle: command.subtitle } : {}),
        ...(command.mark === 'askHappier' ? { icon: () => <AskHappierMark size={ICON_SIZE.md} /> }
            : icon ? { icon: () => <Icon name={icon} size={ICON_SIZE.md} /> } : {}),
        ...(shortcut ? { rightAccessory: () => <KeyHint label={shortcut} /> } : {}),
    };
}

/**
 * Groups commands into one static section per category, preserving the
 * catalog's own order both for categories (first appearance) and for the
 * commands inside them. Matching, ranking, selection, and keyboard behavior
 * stay with SelectionList.
 */
export function buildCommandPaletteSelectionListSections(
    commands: readonly Command[],
): ReadonlyArray<SelectionListSectionDescriptor> {
    const optionsByCategory = new Map<string, SelectionListOption[]>();
    for (const command of commands) {
        // Uncategorized commands share one untitled leading section rather than
        // borrowing another category's heading.
        const category = command.category ?? '';
        const existing = optionsByCategory.get(category);
        if (existing) {
            existing.push(buildOption(command));
            continue;
        }
        optionsByCategory.set(category, [buildOption(command)]);
    }
    const sections: SelectionListSectionDescriptor[] = [];
    let index = 0;
    for (const [category, options] of optionsByCategory) {
        // The section id is positional because category titles are localized
        // display copy; two locales-equal titles must never collapse into one
        // render-plan entry.
        sections.push({
            kind: 'static',
            id: `commands:${index}`,
            ...(category ? { title: category } : {}),
            options,
        });
        index += 1;
    }
    return sections;
}
