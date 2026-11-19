import { z } from 'zod/mini';
import { CollectionTableCardPresentationSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

export const COLLECTION_DISPLAY_SETTING_ANCHOR = 'appearance.collectionDisplay';

const CollectionDisplayIntentSchema = z.strictObject({
    kind: z.literal('workflow'),
    presentation: CollectionTableCardPresentationSchema,
});

export const collectionDisplayStorageBinding: Extract<SettingStorageBinding, { kind: 'owner' }> = {
    scope: 'account',
    kind: 'owner',
    access: 'read_write',
    read: settings => settings.collectionDisplayPreferencesV1,
    parse: value => {
        const result = CollectionDisplayIntentSchema.safeParse(value);
        return result.success ? { success: true, value: result.data } : { success: false };
    },
    mutate: (settings, value) => {
        const { kind, presentation } = value as z.infer<typeof CollectionDisplayIntentSchema>;
        const preferences = settings.collectionDisplayPreferencesV1;
        if (preferences[kind]?.presentation === presentation) return null;
        return {
            collectionDisplayPreferencesV1: {
                ...preferences,
                [kind]: { ...preferences[kind], presentation },
            },
        };
    },
};
