import { z } from 'zod/mini';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { NavigationPlacementPreferencesSchema } from '@/sync/domains/settings/navigationPlacement';
export const CollectionColumnPreferencesSchema = NavigationPlacementPreferencesSchema.check(
 z.refine(preferences => Object.values(preferences.placements).every(placement => placement === 'pinned' || placement === 'hidden')),
);
const Intent = z.strictObject({ collectionId: z.string().check(z.minLength(1)), preferences: z.nullable(CollectionColumnPreferencesSchema) });
export const collectionColumnsStorageBinding: Extract<SettingStorageBinding, { kind: 'owner' }> = {
 scope: 'account', kind: 'owner', access: 'read_write',
 read: settings => settings.collectionColumnPreferencesV1,
 parse: value => { const parsed = Intent.safeParse(value); return parsed.success ? { success: true, value: parsed.data } : { success: false }; },
 mutate: (settings, value) => {
   // Settings admission parsed this intent; CAS applies it to the latest Account map.
   const { collectionId, preferences } = value as z.infer<typeof Intent>;
   const current = settings.collectionColumnPreferencesV1[collectionId];
   if (preferences === null && current === undefined) return null;
   if (JSON.stringify(current) === JSON.stringify(preferences)) return null;
   const next = { ...settings.collectionColumnPreferencesV1 };
   if (preferences === null) delete next[collectionId];
   else next[collectionId] = preferences;
   return { collectionColumnPreferencesV1: next };
 },
};
