import type { TranslationKey } from '@/text';

import {
    resolveActionSettingsTargetSelections,
    type ActionSettingsEntry,
    type ActionSettingsTargetEntry,
} from './buildActionSettingsEntries';

const ACTION_TARGET_SECTIONS = [
    { id: 'app', titleKey: 'settingsActions.sections.app' },
    { id: 'voice', titleKey: 'settingsActions.sections.voice' },
    { id: 'integrations', titleKey: 'settingsActions.sections.integrations' },
] as const satisfies ReadonlyArray<{
    id: ActionSettingsTargetEntry['category'];
    titleKey: Extract<TranslationKey, `settingsActions.sections.${string}`>;
}>;

export type ActionSettingsDisplaySection = Readonly<{
    id: ActionSettingsTargetEntry['category'];
    titleKey: Extract<TranslationKey, `settingsActions.sections.${string}`>;
    targets: readonly ActionSettingsTargetEntry[];
    selectedIds: readonly ActionSettingsTargetEntry['id'][];
}>;

export type ActionSettingsDisplayEntry = ActionSettingsEntry & Readonly<{
    sections: readonly ActionSettingsDisplaySection[];
}>;

export type ActionSettingsUnavailableEntry = Readonly<{
    actionId: ActionSettingsEntry['actionId'];
    title: ActionSettingsEntry['title'];
    targets: readonly ActionSettingsTargetEntry[];
}>;

export function buildActionSettingsDisplayModel(entries: readonly ActionSettingsEntry[]): Readonly<{
    entries: readonly ActionSettingsDisplayEntry[];
    unavailableEntries: readonly ActionSettingsUnavailableEntry[];
}> {
    const displayEntries = entries.map((entry) => {
        const availableTargets = entry.targets.filter((target) => target.state !== 'unavailable');
        const selectedByCategory = resolveActionSettingsTargetSelections(availableTargets);
        const sections = ACTION_TARGET_SECTIONS
            .map((section) => ({
                ...section,
                targets: availableTargets.filter((target) => target.category === section.id),
                selectedIds: selectedByCategory[section.id],
            }))
            .filter((section) => section.targets.length > 0);

        return {
            ...entry,
            sections,
        } satisfies ActionSettingsDisplayEntry;
    });

    const unavailableEntries = entries
        .map((entry) => ({
            actionId: entry.actionId,
            title: entry.title,
            targets: entry.targets.filter((target) => target.state === 'unavailable'),
        }))
        .filter((entry) => entry.targets.length > 0);

    return {
        entries: displayEntries,
        unavailableEntries,
    };
}
