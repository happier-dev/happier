import {
    ACTION_SETTINGS_FAMILY_ORDER,
    ACTION_SETTINGS_FAMILY_TITLE_KEYS,
    resolveActionSettingsFamily,
    type ActionSettingsFamily,
} from './actionSettingsFamily';
import type { ActionSettingsEntry } from './buildActionSettingsEntries';
import type { TranslationKey } from '@/text';

export type ActionSettingsFamilySection = Readonly<{
    family: ActionSettingsFamily;
    titleKey: Extract<TranslationKey, `settingsActions.families.${string}.title`>;
    entries: readonly ActionSettingsEntry[];
}>;

/**
 * Group action-settings entries into ordered, labeled FAMILY sections (FINALIZATION-PLAN §3.3).
 *
 * Preserves the incoming entry order WITHIN each family (the caller sorts by title), renders the
 * runtime families first per {@link ACTION_SETTINGS_FAMILY_ORDER}, and omits empty families so the
 * list never shows a header with zero rows. Each entry's enable + require-approval controls are
 * unchanged — this only adds the per-family grouping the user scans/configures by.
 */
export function groupActionSettingsEntriesByFamily(
    entries: readonly ActionSettingsEntry[],
): readonly ActionSettingsFamilySection[] {
    const entriesByFamily = new Map<ActionSettingsFamily, ActionSettingsEntry[]>();
    for (const entry of entries) {
        const family = resolveActionSettingsFamily(entry.actionId);
        const bucket = entriesByFamily.get(family);
        if (bucket) {
            bucket.push(entry);
        } else {
            entriesByFamily.set(family, [entry]);
        }
    }

    return ACTION_SETTINGS_FAMILY_ORDER.flatMap((family) => {
        const familyEntries = entriesByFamily.get(family);
        if (!familyEntries || familyEntries.length === 0) {
            return [];
        }
        return [{
            family,
            titleKey: ACTION_SETTINGS_FAMILY_TITLE_KEYS[family],
            entries: familyEntries,
        }];
    });
}
