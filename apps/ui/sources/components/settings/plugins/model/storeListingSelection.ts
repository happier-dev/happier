import { MarketplaceCatalogReferenceV1Schema, type MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import { PluginStoreItemReferenceV1Schema, type PluginStoreItemReferenceV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { MachineAdministrationTargetV1Schema, type MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { ThemeReferenceSchema, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { BUILT_IN_PET_IDS_V1 } from '@happier-dev/protocol/pets/constants';
import type { BuiltInPetId } from '@/components/pets/builtIns/builtInPetRegistry';

export type StoreSoftwareListingReference = Extract<MarketplaceCatalogReferenceV1, { type: 'software' }> & Readonly<{
    target?: Readonly<{ scope: ServerAccountScope; machine: MachineAdministrationTargetV1 }>;
}>;
/** Host navigation only; Software retains its native P20 identity, without a registry kind. */
export type StorePluginThemeListingReference = Readonly<{ type: 'pluginTheme'; reference: Extract<ThemeReference, { kind: 'plugin' }> }>;
/** Host navigation only: a pet built into Happier has no catalog listing, so its page opens by its built-in id. */
export type StoreBuiltInPetListingReference = Readonly<{ type: 'builtInPet'; petId: BuiltInPetId }>;
export type StoreListingReference = Exclude<MarketplaceCatalogReferenceV1, { type: 'software' }> | StoreSoftwareListingReference | PluginStoreItemReferenceV1 | StorePluginThemeListingReference
    | StoreBuiltInPetListingReference;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function readStoreSoftwareTarget(value: unknown): NonNullable<StoreSoftwareListingReference['target']> | null {
    if (!record(value, ['scope', 'machine']) || !record(value.scope, ['serverId', 'accountId'])) return null;
    const scope = createServerAccountScope(value.scope.serverId, value.scope.accountId);
    const machine = MachineAdministrationTargetV1Schema.safeParse(value.machine);
    return scope && machine.success ? { scope, machine: machine.data } : null;
}

/** Router envelope admission delegates every native leaf to its canonical schema. */
export function readStoreListingReference(value: unknown): StoreListingReference | null {
    if (record(value, ['type', 'reference']) && value.type === 'pluginTheme') {
        const reference = ThemeReferenceSchema.safeParse(value.reference);
        return reference.success && reference.data.kind === 'plugin' ? { type: 'pluginTheme', reference: reference.data } : null;
    }
    if (record(value, ['type', 'petId']) && value.type === 'builtInPet') {
        const petId = BUILT_IN_PET_IDS_V1.find(id => id === value.petId);
        return petId ? { type: 'builtInPet', petId } : null;
    }
    const contributed = PluginStoreItemReferenceV1Schema.safeParse(value);
    if (contributed.success) return contributed.data;
    if (record(value, ['type', 'target', 'value']) && value.type === 'software') {
        const target = readStoreSoftwareTarget(value.target);
        const reference = MarketplaceCatalogReferenceV1Schema.safeParse({ type: value.type, value: value.value });
        return target && reference.success && reference.data.type === 'software' ? { ...reference.data, target } : null;
    }
    const parsed = MarketplaceCatalogReferenceV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
