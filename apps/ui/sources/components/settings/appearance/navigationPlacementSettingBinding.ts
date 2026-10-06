import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { NavigationSurfacePlacementsV1Schema, readNavigationSurfacePlacements } from '@/sync/domains/settings/mobileSurfacePinning';

/** The same local placement owner used by navigation, exposed by settings.get/settings.set. */
export const navigationPlacementStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: readNavigationSurfacePlacements,
    parse: value => {
        const parsed = NavigationSurfacePlacementsV1Schema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: (_local, value, writeLocal) => {
        const parsed = NavigationSurfacePlacementsV1Schema.safeParse(value);
        if (parsed.success) writeLocal({ navigationSurfacePlacementsV1: parsed.data });
    },
};
