import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { mergeNavigationSurfacePlacements, NavigationSurfacePlacementsV1Schema, readNavigationSurfacePlacements, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';

/** The same local placement owner used by navigation, exposed by settings.get/settings.set. */
export const navigationPlacementStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: readNavigationSurfacePlacements,
    parse: value => {
        const parsed = NavigationSurfacePlacementsV1Schema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: (local, value, writeLocal) => {
        // parse already admitted the patch; preserve unchanged surface identities.
        const patch = value as NavigationSurfacePlacementsV1;
        const current = local.navigationSurfacePlacementsV1;
        const next = mergeNavigationSurfacePlacements(current, patch);
        // The immutable owner returns the same serialized shape as LocalSettings' mutable schema type.
        if (next !== current) writeLocal({ navigationSurfacePlacementsV1: next as LocalSettings['navigationSurfacePlacementsV1'] });
    },
} satisfies SettingStorageBinding;
