import { expect, it } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { collectionColumnsStorageBinding } from './collectionColumnSettings';
it('merges one collection intent and resets only that collection', () => {
 const other = { orderedIds: ['age'], placements: {} };
 const settings = { ...settingsDefaults, collectionColumnPreferencesV1: { other } };
 const parse = collectionColumnsStorageBinding.parse({ collectionId: 'services', preferences: { orderedIds: ['state'], placements: { state: 'hidden' } } });
 expect(parse.success).toBe(true);
 if (!parse.success) throw new Error('refused');
 const delta = collectionColumnsStorageBinding.mutate(settings, parse.value);
 expect(delta?.collectionColumnPreferencesV1?.other).toBe(other);
 expect(delta?.collectionColumnPreferencesV1?.services).toMatchObject({ placements: { state: 'hidden' } });
 const reset = collectionColumnsStorageBinding.mutate({ ...settings, ...delta }, { collectionId: 'services', preferences: null });
 expect(reset?.collectionColumnPreferencesV1).toEqual({ other });
});

it('rejects the navigation-only overflow state at column Action admission', () => {
 expect(collectionColumnsStorageBinding.parse({ collectionId: 'services', preferences: { orderedIds: [], placements: { state: 'overflow' } } }).success).toBe(false);
});
