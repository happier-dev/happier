import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { t } from '@/text';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../shell/settingsCollectionAdapter';

export const profileColumnAdapter = defineSettingsCollectionAdapter(['group', 'status']);
/** Group, enablement and migration review come from useProfilesCollection/profileGrouping. */
export function profileColumnFacts(row: AIBackendProfile, presentation: Readonly<{
    context: string | null; group: string; status: string | null;
}>): SettingsCollectionRowFacts<'group' | 'status'> {
    return { key: row.id, title: row.name, context: presentation.context, status: presentation.status,
        fields: { group: [presentation.group], status: presentation.status ? [presentation.status] : null } };
}

/**
 * What a profile's row says in its icon-only status slot: a provider migration waiting for the person, else a profile
 * that is turned off. A healthy profile is quiet; the retained legacy setup is explained on the profile's page.
 */
export function profileRailStatus(input: Readonly<{
    enabled: boolean;
    migration: 'review' | 'conflict' | 'retained' | null;
}>): Readonly<{ status: CollectionRowStatus; label: string }> | null {
    if (input.migration === 'review') return { status: 'review', label: t('settingsProviders.migration.reviewActionDescription') };
    if (input.migration === 'conflict') return { status: 'review', label: t('settingsProviders.migration.conflictReviewActionDescription') };
    return input.enabled ? null : { status: 'off', label: t('common.disabled') };
}

/** The profile's one context line, unless it is only the line every profile shares ("Any agent"). */
export function profileRailContext(summary: string, anyAgentLabel: string): string | undefined {
    return summary === anyAgentLabel ? undefined : summary;
}
