import { useMemo } from 'react';
import { CollectionEntityKindV1Schema, CollectionSpaceSelectionV1Schema, CollectionSpaceSelectionValueV1Schema, resolveCollectionSpacesV1,
    type CollectionSpaceSelectionV1, type CollectionEntityKindV1, type CollectionSpacesV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createPersistentUiState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';

const selections = createPersistentUiState('collection-space-v1', value => CollectionSpaceSelectionValueV1Schema.parse({ spaceId: value }).spaceId);
const key = (scope: string, entityKind: CollectionEntityKindV1) => JSON.stringify([scope, entityKind]);
const EMPTY_SELECTION: CollectionSpaceSelectionV1 = { v: 1, byAccountScope: {} };

function selectedSpace(scopeKey: string, entityKind: CollectionEntityKindV1, spaceId: string | undefined): CollectionSpaceSelectionV1 {
    return spaceId === undefined ? EMPTY_SELECTION : { v: 1, byAccountScope: { [scopeKey]: { [entityKind]: { spaceId } } } };
}

export function readCollectionSpaceId(scopeKey: string, entityKind: CollectionEntityKindV1): string | undefined {
    return selections.read(key(scopeKey, entityKind));
}

export function readCollectionSpaceSelection(scopeKey: string, entityKind: CollectionEntityKindV1): CollectionSpaceSelectionV1 {
    return selectedSpace(scopeKey, entityKind, readCollectionSpaceId(scopeKey, entityKind));
}

export function useCollectionSpaceSelection(scopeKey: string, entityKind: CollectionEntityKindV1): CollectionSpaceSelectionV1 {
    const spaceId = usePersistentUiStateValue(selections, scopeKey ? key(scopeKey, entityKind) : null);
    return useMemo(() => selectedSpace(scopeKey, entityKind, spaceId), [spaceId, scopeKey, entityKind]);
}

/** Captured Account authority serves both mounted navigation and Actions. */
export async function writeCollectionSpaceSelectionV1(input: Readonly<{
    scope: AccountSettingsScope | null | undefined;
    entityKind: CollectionEntityKindV1;
    spaceId: string;
    isCurrent(): boolean;
    readSettings(): Readonly<{ collectionSpacesV1: CollectionSpacesV1 }> | Promise<Readonly<{ collectionSpacesV1: CollectionSpacesV1 }>>;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: 'setting_not_bound' | 'space_not_found' }>> {
    if (!input.scope || !input.isCurrent()) return { ok: false, reason: 'setting_not_bound' };
    const settings = await input.readSettings();
    if (!input.isCurrent()) return { ok: false, reason: 'setting_not_bound' };
    if (!resolveCollectionSpacesV1(settings.collectionSpacesV1, input.entityKind).some(space => space.id === input.spaceId)) return { ok: false, reason: 'space_not_found' };
    selections.set(key(accountSettingsScopeKeySuffix(input.scope), input.entityKind), input.spaceId);
    return { ok: true };
}

/** Import each exact predecessor scope/entity independently; a current destination wins. */
export function migrateCollectionSpaceUiStateFromSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    const record = settings as Record<string, unknown>;
    if (!Object.hasOwn(record, 'collectionSpaceV1')) return settings;
    const parsed = CollectionSpaceSelectionV1Schema.parse(record.collectionSpaceV1);
    for (const [scopeKey, byEntity] of Object.entries(parsed.byAccountScope)) {
        for (const entityKind of CollectionEntityKindV1Schema.options) {
            const selection = byEntity[entityKind];
            if (selection && selections.readStrict(key(scopeKey, entityKind)) === undefined) {
                selections.set(key(scopeKey, entityKind), selection.spaceId);
            }
        }
    }
    const { collectionSpaceV1: _legacy, ...retained } = record;
    return retained;
}
