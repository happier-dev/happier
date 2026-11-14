import { z } from 'zod/mini';

import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

export const COLLECTION_RAIL_WIDTH_SETTING_ANCHOR = 'appearance.collectionRailWidths';
export const COLLECTION_RAIL_WIDTH_SETTING_OWNER = 'collectionRailWidthStorageBinding';

const RailWidthIntent = z.strictObject({ resizeKey: z.string(), widthPx: z.nullable(z.number()) });
type RailWidthIntent = z.infer<typeof RailWidthIntent>;

/** The rail owns keyed intent; layout geometry continues to clamp the rendered width. */
export const collectionRailWidthStorageBinding: Extract<SettingStorageBinding, { kind: 'localOwner' }> = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: local => local.collectionRailWidthsV1,
    parse: value => {
        const parsed = RailWidthIntent.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: (local, value, writeLocal, context) => {
        // The Settings boundary admitted this intent through parse above.
        const { resizeKey, widthPx } = value as RailWidthIntent;
        const current = (context?.readLocalSettings?.() ?? local).collectionRailWidthsV1;
        if (widthPx === null ? !Object.hasOwn(current, resizeKey) : current[resizeKey] === widthPx) return;
        const next = widthPx === null ? { ...current } : { ...current, [resizeKey]: widthPx };
        if (widthPx === null) delete next[resizeKey];
        writeLocal({ collectionRailWidthsV1: next });
    },
};
