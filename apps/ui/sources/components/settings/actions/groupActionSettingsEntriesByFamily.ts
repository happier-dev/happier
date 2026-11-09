import {
    ACTION_SETTINGS_FAMILY_ORDER,
    ACTION_SETTINGS_FAMILY_SPLIT,
    ACTION_SETTINGS_FAMILY_TITLE_KEYS,
    resolveActionSettingsFamily,
    type ActionSettingsFamily,
} from './actionSettingsFamily';
import { AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseQualifiedPluginResourcePolicyId } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionSettingsEntry } from './buildActionSettingsEntries';
import type { TranslationKey } from '@/text';

export type ActionSettingsFamilySection = Readonly<{
    /** Unique per section, including two sections of one family. */
    key: string;
    family: ActionSettingsFamily;
    /** A contributing plugin's own name, which titles its section instead of `titleKey`. */
    title?: string;
    titleKey: Extract<TranslationKey, `settingsActions.families.${string}.title`>;
    descriptionKey?: Extract<TranslationKey, `settingsActions.families.${string}.description`>;
    relatedActionIds?: readonly ActionId[];
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
    /** Contributing plugins' display names, from the selected machine's projection. */
    pluginTitles?: ReadonlyMap<string, string>,
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

    return ACTION_SETTINGS_FAMILY_ORDER.flatMap<ActionSettingsFamilySection>((family) => {
        const familyEntries = entriesByFamily.get(family);
        if (!familyEntries || familyEntries.length === 0) {
            return [];
        }
        if (ACTION_SETTINGS_FAMILY_SPLIT[family] === 'safety') {
            const reading: ActionSettingsEntry[] = [];
            const changing: ActionSettingsEntry[] = [];
            for (const entry of familyEntries) {
                const spec = entry.kind === 'host' ? getActionSpec(entry.actionId) : null;
                const readOnly = spec?.safety === 'safe'
                    && (spec.sideEffectClass === 'read' || spec.sideEffectClass === 'none')
                    && !AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS.some((id) => id === entry.actionId);
                (readOnly ? reading : changing).push(entry);
            }
            return ([
                ['reading', reading],
                ['changing', changing],
            ] as const).flatMap(([section, sectionEntries]) => sectionEntries.length > 0 ? [{
                key: `${family}:${section}`,
                family,
                titleKey: `settingsActions.families.resources.${section}.title` as const,
                descriptionKey: `settingsActions.families.resources.${section}.description` as const,
                ...(section === 'changing' ? { relatedActionIds: ['session.stop', 'scm.worktree.remove'] as const } : {}),
                entries: sectionEntries,
            }] : []);
        }
        if (family === 'plugins' && pluginTitles !== undefined) {
            // Provenance is the section: each contributing plugin's Actions sit under its own
            // name, read once before the rows, instead of one bucket that hides where they
            // come from. A plugin the projection does not name keeps the family's title.
            const byPlugin = new Map<string, ActionSettingsEntry[]>();
            for (const entry of familyEntries) {
                const pluginId = (parseQualifiedPluginActionId(entry.actionId) ?? parseQualifiedPluginResourcePolicyId(entry.actionId))?.pluginId ?? '';
                const bucket = byPlugin.get(pluginId);
                if (bucket) bucket.push(entry); else byPlugin.set(pluginId, [entry]);
            }
            return [...byPlugin.entries()]
                .map(([pluginId, pluginEntries]) => {
                    const title = pluginTitles.get(pluginId);
                    return {
                        key: `${family}:${pluginId}`,
                        family,
                        titleKey: ACTION_SETTINGS_FAMILY_TITLE_KEYS[family],
                        ...(title === undefined ? {} : { title }),
                        entries: pluginEntries,
                    };
                })
                .sort((left, right) => (left.title ?? '').localeCompare(right.title ?? ''));
        }
        return [{
            key: family,
            family,
            titleKey: ACTION_SETTINGS_FAMILY_TITLE_KEYS[family],
            entries: familyEntries,
        }];
    });
}
